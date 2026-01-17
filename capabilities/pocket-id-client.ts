import { Capability, K8s, Log, kind } from "pepr";
import {
  PocketIDClient,
  PocketIDClientCRD,
  Phase,
  PocketIDClientStatus,
  Condition,
  SecretTemplate,
} from "../crd/pocketidclient";
import { OidcService, OpenAPI } from "../dist/pocketid-client";
import type { dto_OidcClientCreateDto } from "../dist/pocketid-client";

export const PocketIDClientCapability = new Capability({
  name: "pocket-id-client",
  description: "Create PocketID Clients based on CRDs",
});

const lastGenByUid = new Map<string, number>();

const { When } = PocketIDClientCapability;

const FINALIZER = "pocketidclient.jeffrescignano.io/finalizer";

// Retry configuration
const RETRY_CONFIG = {
  baseDelayMs: 5000, // 5 seconds base delay
  maxDelayMs: 300000, // 5 minutes max delay
  maxRetries: 10, // Max retry attempts before giving up
};

// Calculate exponential backoff delay
function calculateBackoffDelay(retryAttempt: number): number {
  // Exponential backoff: baseDelay * 2^attempt with jitter
  const exponentialDelay = RETRY_CONFIG.baseDelayMs * Math.pow(2, retryAttempt - 1);
  const jitter = Math.random() * 1000; // Add up to 1 second of jitter
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelayMs);
}

// Check if we should skip reconciliation due to backoff
function shouldSkipDueToBackoff(client: PocketIDClient): boolean {
  const status = client.status;
  if (!status?.nextRetryTime || status.phase === Phase.Ready) {
    return false;
  }

  const nextRetry = new Date(status.nextRetryTime).getTime();
  const now = Date.now();

  if (now < nextRetry) {
    const waitSeconds = Math.ceil((nextRetry - now) / 1000);
    Log.debug(
      {
        namespace: client.metadata?.namespace,
        name: client.metadata?.name,
        waitSeconds,
      },
      "Skipping reconciliation due to backoff",
    );
    return true;
  }

  return false;
}

// Configure the OpenAPI client from environment variables
function configureApiClient() {
  OpenAPI.BASE = process.env.POCKETID_API_URL || "http://pocket-id.pocket-id.svc";
  const apiKey = process.env.POCKETID_API_TOKEN;
  OpenAPI.HEADERS = apiKey ? { "X-API-KEY": apiKey.trim() } : {};
}

// Template context for secret template rendering
interface TemplateContext {
  ClientID: string;
  ClientSecret: string;
  ClientName: string;
  Namespace: string;
  ResourceName: string;
}

// Render a template string with the provided context
function renderTemplate(template: string, context: TemplateContext): string {
  return template
    .replace(/\{\{\s*\.ClientID\s*\}\}/g, context.ClientID)
    .replace(/\{\{\s*\.ClientSecret\s*\}\}/g, context.ClientSecret)
    .replace(/\{\{\s*\.ClientName\s*\}\}/g, context.ClientName)
    .replace(/\{\{\s*\.Namespace\s*\}\}/g, context.Namespace)
    .replace(/\{\{\s*\.ResourceName\s*\}\}/g, context.ResourceName);
}

// Register the CRD with the cluster on startup
export async function registerCRD() {
  try {
    await K8s(kind.CustomResourceDefinition).Apply(PocketIDClientCRD, {
      force: true,
    });
    Log.info("PocketIDClient CRD registered successfully");
  } catch (err) {
    Log.error({ err }, "Failed to register PocketIDClient CRD");
    throw err;
  }
}

// Helper to create a condition
function createCondition(
  type: string,
  status: "True" | "False" | "Unknown",
  reason: string,
  message: string,
  generation?: number,
): Condition {
  return {
    type,
    status,
    reason,
    message,
    lastTransitionTime: new Date().toISOString(),
    observedGeneration: generation,
  };
}

// Helper to update the status of a PocketIDClient
async function updateStatus(client: PocketIDClient, status: Partial<PocketIDClientStatus>) {
  const { namespace, name } = client.metadata!;
  const currentStatus = client.status || {};
  const newStatus: PocketIDClientStatus = {
    ...currentStatus,
    ...status,
    observedGeneration: client.metadata?.generation,
  };

  try {
    await K8s(PocketIDClient).PatchStatus({
      metadata: {
        name,
        namespace,
      },
      status: newStatus,
    });
    Log.debug({ namespace, name, status: newStatus }, "Status updated");
  } catch (err) {
    Log.error({ err, namespace, name }, "Failed to update status");
  }
}

// Helper to add a condition to the status
async function addCondition(client: PocketIDClient, condition: Condition) {
  const { name, namespace } = client.metadata!;
  const conditions = client.status?.conditions ?? [];

  const idx = conditions.findIndex(c => c.type === condition.type);
  if (idx >= 0) conditions[idx] = condition;
  else conditions.push(condition);

  await K8s(PocketIDClient).PatchStatus({
    metadata: { name, namespace },
    status: { conditions }, // 🔑 DO NOT MERGE OTHER FIELDS
  });
}

// Create or update the Kubernetes secret with client credentials
async function upsertSecret(
  namespace: string,
  secretName: string,
  clientId: string,
  clientSecret: string,
  ownerRef: { name: string; uid: string },
  secretTemplate?: SecretTemplate,
  clientName?: string,
) {
  // Build template context
  const context: TemplateContext = {
    ClientID: clientId,
    ClientSecret: clientSecret,
    ClientName: clientName || "",
    Namespace: namespace,
    ResourceName: ownerRef.name,
  };

  // Determine secret data - use template if provided, otherwise default
  let stringData: Record<string, string>;
  if (secretTemplate?.data) {
    stringData = {};
    for (const [key, value] of Object.entries(secretTemplate.data)) {
      stringData[key] = renderTemplate(value, context);
    }
  } else {
    stringData = {
      CLIENT_ID: clientId,
      CLIENT_SECRET: clientSecret,
    };
  }

  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace,
      ownerReferences: [
        {
          apiVersion: "jeffrescignano.io/v1alpha1",
          kind: "PocketIDClient",
          name: ownerRef.name,
          uid: ownerRef.uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    type: "Opaque",
    stringData,
  };

  await K8s(kind.Secret).Apply(secret, { force: true });
  Log.info({ namespace, secretName }, "Secret created/updated");
}

// Delete the Kubernetes secret
async function deleteSecret(namespace: string, secretName: string) {
  try {
    await K8s(kind.Secret).InNamespace(namespace).Delete(secretName);
    Log.info({ namespace, secretName }, "Secret deleted");
  } catch (err) {
    // Ignore not found errors
    if ((err as { status?: number }).status !== 404) {
      throw err;
    }
  }
}

// Add finalizer to the resource
async function addFinalizer(client: PocketIDClient) {
  const finalizers = client.metadata?.finalizers || [];
  if (!finalizers.includes(FINALIZER)) {
    await K8s(PocketIDClient).Apply(
      {
        metadata: {
          name: client.metadata!.name,
          namespace: client.metadata!.namespace,
          finalizers: [...finalizers, FINALIZER],
        },
      },
      { force: true },
    );
  }
}

// Remove finalizer from the resource
async function removeFinalizer(client: PocketIDClient) {
  const finalizers = client.metadata?.finalizers || [];
  if (finalizers.includes(FINALIZER)) {
    await K8s(PocketIDClient).Apply(
      {
        metadata: {
          name: client.metadata!.name,
          namespace: client.metadata!.namespace,
          finalizers: finalizers.filter(f => f !== FINALIZER),
        },
      },
      { force: true },
    );
  }
}

// Check if the client exists in PocketID
async function clientExists(clientId: string): Promise<boolean> {
  try {
    await OidcService.getApiOidcClients1(clientId);
    return true;
  } catch {
    return false;
  }
}

// Reconcile a PocketIDClient resource
async function reconcile(client: PocketIDClient) {
  const { namespace, name, uid, generation, deletionTimestamp } = client.metadata!;
  const spec = client.spec;

  configureApiClient();

  // Check if resource is being deleted
  if (deletionTimestamp) {
    Log.info({ namespace, name }, "PocketIDClient is being deleted");
    await handleDeletion(client);
    return;
  }

  // Skip if already processed this generation
  if (client.status?.observedGeneration === generation && client.status?.phase === Phase.Ready) {
    Log.debug({ namespace, name }, "Already reconciled this generation");
    return;
  }

  // Skip if we're in backoff period (unless generation changed, meaning user made updates)
  if (shouldSkipDueToBackoff(client) && client.status?.observedGeneration === generation) {
    return;
  }

  // Check if max retries exceeded
  const currentRetry = client.status?.retryAttempt || 0;
  if (currentRetry >= RETRY_CONFIG.maxRetries) {
    Log.warn({ namespace, name, retryAttempt: currentRetry }, "Max retries exceeded, giving up");
    await addCondition(
      client,
      createCondition(
        "Ready",
        "False",
        "MaxRetriesExceeded",
        `Gave up after ${currentRetry} failed attempts. Manual intervention required.`,
        generation,
      ),
    );
    return;
  }

  // Add finalizer if not present
  await addFinalizer(client);

  // Update status to Pending (or Retrying if this is a retry)
  const newPhase = currentRetry > 0 ? Phase.Retrying : Phase.Pending;
  await updateStatus(client, { phase: newPhase, nextRetryTime: undefined });
  await addCondition(
    client,
    createCondition(
      "Reconciling",
      "True",
      currentRetry > 0 ? "RetryStarted" : "ReconcileStarted",
      currentRetry > 0
        ? `Retry attempt ${currentRetry + 1}/${RETRY_CONFIG.maxRetries}`
        : "Starting reconciliation",
      generation,
    ),
  );

  try {
    if (!spec?.name) {
      throw new Error("spec.name is required");
    }

    // Determine the client ID - use spec.id if provided, otherwise use CR name
    const clientId = spec.id || name!;
    // Use custom secret name from template if provided, otherwise default
    const secretName = spec.secretTemplate?.name || `${name}-credentials`;

    // Check if client already exists
    const exists = await clientExists(clientId);

    let clientSecret: string;

    if (exists) {
      // Update existing client
      Log.info({ namespace, name, clientId }, "Updating existing OIDC client");

      await OidcService.putApiOidcClients(clientId, {
        name: spec.name,
        callbackURLs: spec.callbackURLs,
        logoutCallbackURLs: spec.logoutCallbackURLs,
        isPublic: spec.isPublic,
        pkceEnabled: spec.pkceEnabled,
        isGroupRestricted: spec.isGroupRestricted,
        launchURL: spec.launchURL,
        requiresReauthentication: spec.requiresReauthentication,
      });

      // Generate a new secret
      const secretResponse = await OidcService.postApiOidcClientsSecret(clientId);
      clientSecret = secretResponse.secret;

      await addCondition(
        client,
        createCondition(
          "ClientUpdated",
          "True",
          "UpdateSucceeded",
          `OIDC client ${clientId} updated successfully`,
          generation,
        ),
      );
    } else {
      // Create new client
      Log.info({ namespace, name, clientId }, "Creating new OIDC client");

      const createDto: dto_OidcClientCreateDto = {
        id: clientId,
        name: spec.name,
        callbackURLs: spec.callbackURLs,
        logoutCallbackURLs: spec.logoutCallbackURLs,
        isPublic: spec.isPublic,
        pkceEnabled: spec.pkceEnabled,
        isGroupRestricted: spec.isGroupRestricted,
        launchURL: spec.launchURL,
        requiresReauthentication: spec.requiresReauthentication,
      };

      await OidcService.postApiOidcClients(createDto);

      // Generate a secret for the new client
      const secretResponse = await OidcService.postApiOidcClientsSecret(clientId);
      clientSecret = secretResponse.secret;

      await addCondition(
        client,
        createCondition(
          "ClientCreated",
          "True",
          "CreateSucceeded",
          `OIDC client ${clientId} created successfully`,
          generation,
        ),
      );
    }

    // Create/update the Kubernetes secret
    await upsertSecret(
      namespace!,
      secretName,
      clientId,
      clientSecret,
      { name: name!, uid: uid! },
      spec.secretTemplate,
      spec.name,
    );

    await addCondition(
      client,
      createCondition(
        "SecretCreated",
        "True",
        "SecretReady",
        `Secret ${secretName} created/updated`,
        generation,
      ),
    );

    // Update status to Ready
    await updateStatus(client, {
      phase: Phase.Ready,
      clientId,
      secretName,
      retryAttempt: 0,
      nextRetryTime: undefined,
    });

    await addCondition(
      client,
      createCondition(
        "Ready",
        "True",
        "ReconcileSucceeded",
        "Reconciliation completed successfully",
        generation,
      ),
    );

    Log.info({ namespace, name, clientId }, "PocketIDClient reconciled successfully");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const retryAttempt = (client.status?.retryAttempt || 0) + 1;
    const backoffDelay = calculateBackoffDelay(retryAttempt);
    const nextRetryTime = new Date(Date.now() + backoffDelay).toISOString();

    Log.error(
      {
        err,
        namespace,
        name,
        retryAttempt,
        nextRetryInSeconds: Math.ceil(backoffDelay / 1000),
      },
      "Failed to reconcile PocketIDClient, will retry with backoff",
    );

    await updateStatus(client, {
      phase: Phase.Failed,
      retryAttempt,
      nextRetryTime,
    });

    await addCondition(
      client,
      createCondition(
        "Ready",
        "False",
        "ReconcileFailed",
        `Reconciliation failed: ${errorMessage}. Retry ${retryAttempt}/${RETRY_CONFIG.maxRetries} scheduled.`,
        generation,
      ),
    );
  }
}

// Handle deletion of a PocketIDClient
async function handleDeletion(client: PocketIDClient) {
  const { namespace, name } = client.metadata!;

  await updateStatus(client, { phase: Phase.Removing });

  try {
    configureApiClient();

    // Determine the client ID
    const clientId = client.status?.clientId || client.spec?.id || name!;

    // Delete the OIDC client from PocketID
    if (await clientExists(clientId)) {
      Log.info({ namespace, name, clientId }, "Deleting OIDC client from PocketID");
      await OidcService.deleteApiOidcClients(clientId);
    }

    // Delete the secret (owner reference should handle this, but be explicit)
    const secretName = client.status?.secretName || `${name}-credentials`;
    await deleteSecret(namespace!, secretName);

    // Remove the finalizer to allow deletion
    await removeFinalizer(client);

    Log.info({ namespace, name }, "PocketIDClient deletion completed");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    Log.error({ err, namespace, name }, "Failed to delete PocketIDClient");

    await updateStatus(client, { phase: Phase.RemovalFailed });

    await addCondition(
      client,
      createCondition(
        "Ready",
        "False",
        "DeletionFailed",
        `Deletion failed: ${errorMessage}`,
        client.metadata?.generation,
      ),
    );
  }
}

// Watch for PocketIDClient resources - create/update
When(PocketIDClient)
  .IsCreatedOrUpdated()
  .Watch(async client => {
    const { uid, generation, deletionTimestamp, namespace, name } = client.metadata!;

    // Always allow deletions through (finalizer flow)
    if (!deletionTimestamp) {
      // generation is a number; don't use `!generation` because 0 would be falsey
      if (!uid || generation === undefined) return;

      const last = lastGenByUid.get(uid);
      if (last === generation) {
        Log.debug({ namespace, name, uid, generation }, "Ignoring status-only update");
        return;
      }
      lastGenByUid.set(uid, generation);
    }

    Log.info(
      { namespace: client.metadata!.namespace, name: client.metadata!.name },
      "PocketIDClient created or updated",
    );
    await reconcile(client);
  });

// Watch for PocketIDClient resources - deletion (handled via finalizer in reconcile)
When(PocketIDClient)
  .IsDeleted()
  .Watch(async client => {
    const { namespace, name } = client.metadata!;
    Log.info({ namespace, name }, "PocketIDClient deleted");
    // Deletion is handled by the finalizer in the reconcile function
  });
