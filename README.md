# pocket-id-k8s-operator

A Kubernetes Operator for automating the creation and management of [PocketID](https://github.com/stonith404/pocket-id) OIDC clients. Built with [Pepr](https://pepr.dev/).

## What it does

This operator watches for `PocketIDClient` custom resources and automatically:

1. **Creates OIDC clients** in PocketID when a `PocketIDClient` resource is created
2. **Updates OIDC clients** when the `PocketIDClient` spec changes
3. **Deletes OIDC clients** from PocketID when the `PocketIDClient` resource is deleted
4. **Creates Kubernetes Secrets** containing the client credentials (client ID and secret)
5. **Handles failures gracefully** with exponential backoff retry logic

## Installation

### Prerequisites

- Kubernetes cluster (v1.20+)
- PocketID instance with API access
- Helm 3.x
- Node.js 20+ (for development)

### Configuration

The operator requires the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `POCKETID_API_URL` | URL of the PocketID API | `http://pocket-id.pocket-id.svc` |
| `POCKETID_API_TOKEN` | API token for authentication | (required) |

### Deploy the Operator

#### Step 1: Build the Helm chart

```bash
npx pepr build
```

This generates a Helm chart in `dist/pocket-id-operator-chart/`.

#### Step 2: Create a Secret with PocketID credentials

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: pocketid-credentials
  namespace: pepr-system
type: Opaque
stringData:
  POCKETID_API_URL: "https://pocket-id.example.com"
  POCKETID_API_TOKEN: "your-api-token"
```

```bash
kubectl create namespace pepr-system
kubectl apply -f pocketid-secret.yaml
```

#### Step 3: Deploy with Helm

Using a values override file

Create a `values-override.yaml`:

```yaml
watcher:
  envFrom:
    - secretRef:
        name: pocketid-credentials
```

Then install:

```bash
helm install pocket-id-operator ./dist/pocket-id-operator-chart \
  --namespace pepr-system \
  -f values-override.yaml
```

#### Alternative: Mixed configuration

If you prefer to set the API URL directly and only reference the secret for the token:

```yaml
watcher:
  env:
    - name: PEPR_PRETTY_LOG
      value: 'false'
    - name: LOG_LEVEL
      value: 'info'
    - name: POCKETID_API_URL
      value: 'https://pocket-id.example.com'
    - name: POCKETID_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: pocketid-credentials
          key: api-token
```

## Usage

### Basic Example

Create a `PocketIDClient` resource to provision an OIDC client:

```yaml
apiVersion: jeffrescignano.io/v1alpha1
kind: PocketIDClient
metadata:
  name: my-app
  namespace: default
spec:
  name: "My Application"
  callbackURLs:
    - "https://my-app.example.com/callback"
    - "https://my-app.example.com/oauth2/callback"
  logoutCallbackURLs:
    - "https://my-app.example.com/logout"
```

This creates:
- An OIDC client in PocketID with the name "My Application"
- A Kubernetes Secret named `my-app-credentials` containing the client credentials

### Full Example with All Options

```yaml
apiVersion: jeffrescignano.io/v1alpha1
kind: PocketIDClient
metadata:
  name: my-secure-app
  namespace: default
spec:
  # Required: Display name for the client in PocketID
  name: "My Secure Application"

  # Optional: Custom client ID (defaults to the CR name)
  id: "custom-client-id"

  # Required: OAuth2 callback URLs
  callbackURLs:
    - "https://my-app.example.com/callback"

  # Optional: Logout callback URLs
  logoutCallbackURLs:
    - "https://my-app.example.com/logout"

  # Optional: Public client (no client secret required)
  isPublic: false

  # Optional: Enable PKCE
  pkceEnabled: true

  # Optional: Restrict to specific groups
  isGroupRestricted: false

  # Optional: Application launch URL (for SSO portals)
  launchURL: "https://my-app.example.com"

  # Optional: Require re-authentication
  requiresReauthentication: false

  # Optional: Customize the generated secret
  secretTemplate:
    name: "my-custom-secret-name"
    data:
      OIDC_CLIENT_ID: "{{ .ClientID }}"
      OIDC_CLIENT_SECRET: "{{ .ClientSecret }}"
      OIDC_ISSUER: "https://auth.example.com"
```

### Secret Template

The `secretTemplate` field allows you to customize the generated Kubernetes Secret:

#### Default Secret Format

Without a `secretTemplate`, the operator creates a secret with:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <cr-name>-credentials
type: Opaque
data:
  CLIENT_ID: <base64-encoded-client-id>
  CLIENT_SECRET: <base64-encoded-client-secret>
```

#### Custom Secret Format

With a `secretTemplate`, you can customize the secret name and data keys:

```yaml
spec:
  secretTemplate:
    name: "my-app-oidc-config"
    data:
      # Use template variables to inject values
      client-id: "{{ .ClientID }}"
      client-secret: "{{ .ClientSecret }}"
      # You can also include static values
      issuer: "https://auth.example.com"
      # Or combine template variables with static text
      config: |
        {
          "clientId": "{{ .ClientID }}",
          "clientSecret": "{{ .ClientSecret }}",
          "clientName": "{{ .ClientName }}"
        }
```

#### Available Template Variables

| Variable | Description |
|----------|-------------|
| `{{ .ClientID }}` | The OIDC client ID |
| `{{ .ClientSecret }}` | The OIDC client secret |
| `{{ .ClientName }}` | The display name from `spec.name` |
| `{{ .Namespace }}` | The namespace of the PocketIDClient resource |
| `{{ .ResourceName }}` | The name of the PocketIDClient resource |

### Using the Secret in Your Application

Reference the secret in your deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: OIDC_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: my-app-credentials
                  key: CLIENT_ID
            - name: OIDC_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: my-app-credentials
                  key: CLIENT_SECRET
```

Or mount the entire secret as environment variables:

```yaml
envFrom:
  - secretRef:
      name: my-app-credentials
```

## Status and Conditions

The operator updates the status of `PocketIDClient` resources to reflect their state:

```bash
kubectl get pocketidclients
```

```
NAME     STATUS   CLIENT ID   AGE
my-app   Ready    my-app      5m
```

### Status Phases

| Phase | Description |
|-------|-------------|
| `Pending` | Initial reconciliation in progress |
| `Ready` | Client successfully created/updated |
| `Failed` | Reconciliation failed (will retry) |
| `Retrying` | Retry attempt in progress |
| `Removing` | Deletion in progress |
| `RemovalFailed` | Deletion failed |

### Viewing Detailed Status

```bash
kubectl describe pocketidclient my-app
```

The status includes Kubernetes-style conditions showing the history of operations:

```yaml
status:
  phase: Ready
  clientId: my-app
  secretName: my-app-credentials
  conditions:
    - type: Ready
      status: "True"
      reason: ReconcileSucceeded
      message: Reconciliation completed successfully
```

## Retry Behavior

When reconciliation fails (e.g., PocketID is unavailable), the operator uses exponential backoff:

- Base delay: 5 seconds
- Maximum delay: 5 minutes
- Maximum retries: 10 attempts

After max retries are exceeded, manual intervention is required. Update the `PocketIDClient` spec to trigger a new reconciliation attempt.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npx pepr dev

# Build for production
npx pepr build

# Create a local k3d cluster for testing
npm run k3d-setup
```

## License

MIT
