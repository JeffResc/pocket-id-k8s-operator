import {
  V1CustomResourceDefinitionVersion,
  V1JSONSchemaProps,
  V1CustomResourceDefinition,
} from "@kubernetes/client-node";
import { GenericKind, RegisterKind } from "kubernetes-fluent-client";
import swagger from "../../generated/swagger.json";
import type { dto_OidcClientCreateDto } from "../../dist/pocketid-client";

// Resolve $ref references in the swagger schema for Kubernetes CRD compatibility
function resolveRefs(
  schema: Record<string, unknown>,
  definitions: Record<string, unknown>,
): V1JSONSchemaProps {
  if (typeof schema !== "object" || schema === null) {
    return schema as V1JSONSchemaProps;
  }

  // Handle $ref
  if ("$ref" in schema && typeof schema.$ref === "string") {
    const refPath = schema.$ref.replace("#/definitions/", "");
    const resolved = definitions[refPath] as Record<string, unknown>;
    if (resolved) {
      return resolveRefs({ ...resolved }, definitions);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") continue; // Skip $ref keys
    if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === "object" && item !== null
          ? resolveRefs(item as Record<string, unknown>, definitions)
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = resolveRefs(value as Record<string, unknown>, definitions);
    } else {
      result[key] = value;
    }
  }
  return result as V1JSONSchemaProps;
}

// Get the spec schema from swagger, resolving $ref references
const rawSpecSchema = swagger.definitions["dto.OidcClientCreateDto"] as Record<string, unknown>;
const baseSpecSchema = resolveRefs(rawSpecSchema, swagger.definitions as Record<string, unknown>);

// Extend the spec schema with secretTemplate
const specSchema: V1JSONSchemaProps = {
  ...baseSpecSchema,
  properties: {
    ...(baseSpecSchema.properties as Record<string, V1JSONSchemaProps>),
    secretTemplate: {
      type: "object",
      description: "Optional template for customizing the generated secret",
      properties: {
        name: {
          type: "string",
          description: "Custom name for the secret (defaults to {cr-name}-credentials)",
        },
        data: {
          type: "object",
          description:
            "Key-value pairs for secret data. Values support Go-style templates: {{ .ClientID }}, {{ .ClientSecret }}, {{ .ClientName }}, {{ .Namespace }}, {{ .ResourceName }}",
          additionalProperties: {
            type: "string",
          },
        },
      },
    },
  },
};

// Phase enum for status tracking
export enum Phase {
  Pending = "Pending",
  Ready = "Ready",
  Failed = "Failed",
  Retrying = "Retrying",
  Removing = "Removing",
  RemovalFailed = "RemovalFailed",
}

// Status condition interface following Kubernetes conventions
export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  observedGeneration?: number;
  lastTransitionTime: string;
  reason: string;
  message: string;
}

// Secret template interface for customizing the generated secret
export interface SecretTemplate {
  name?: string;
  data?: Record<string, string>;
}

// Status interface for PocketIDClient
export interface PocketIDClientStatus {
  observedGeneration?: number;
  conditions?: Condition[];
  phase?: Phase;
  retryAttempt?: number;
  nextRetryTime?: string;
  clientId?: string;
  secretName?: string;
}

// Spec type extending the generated swagger types with additional fields
export type PocketIDClientSpec = dto_OidcClientCreateDto & {
  secretTemplate?: SecretTemplate;
};

// The PocketIDClient class extending GenericKind for use with Pepr
export class PocketIDClient extends GenericKind {
  spec?: PocketIDClientSpec;
  status?: PocketIDClientStatus;
}

// Register the kind with kubernetes-fluent-client so Pepr can use it
RegisterKind(PocketIDClient, {
  group: "jeffrescignano.io",
  version: "v1alpha1",
  kind: "PocketIDClient",
  plural: "pocketidclients",
});

// CRD version definition
const v1alpha1: V1CustomResourceDefinitionVersion = {
  name: "v1alpha1",
  served: true,
  storage: true,
  additionalPrinterColumns: [
    {
      name: "Status",
      type: "string",
      description: "The status of the client",
      jsonPath: ".status.phase",
    },
    {
      name: "Client ID",
      type: "string",
      description: "The PocketID client ID",
      jsonPath: ".status.clientId",
    },
    {
      name: "Retries",
      type: "integer",
      description: "Number of retry attempts",
      jsonPath: ".status.retryAttempt",
      priority: 1,
    },
    {
      name: "Next Retry",
      type: "date",
      description: "When the next retry will occur",
      jsonPath: ".status.nextRetryTime",
      priority: 1,
    },
    {
      name: "Age",
      type: "date",
      jsonPath: ".metadata.creationTimestamp",
    },
  ],
  subresources: {
    status: {},
  },
  schema: {
    openAPIV3Schema: {
      type: "object",
      properties: {
        status: {
          type: "object",
          properties: {
            observedGeneration: {
              type: "integer",
            },
            conditions: {
              description: "Status conditions following Kubernetes-style conventions",
              type: "array",
              items: {
                type: "object",
                required: ["type", "status", "lastTransitionTime", "reason", "message"],
                properties: {
                  type: {
                    description:
                      "Type of condition in CamelCase or in foo.example.com/CamelCase format",
                    type: "string",
                  },
                  status: {
                    description: "Status of the condition, one of True, False, Unknown",
                    type: "string",
                    enum: ["True", "False", "Unknown"],
                  },
                  observedGeneration: {
                    description:
                      "Represents the .metadata.generation that the condition was set based upon",
                    type: "integer",
                  },
                  lastTransitionTime: {
                    description:
                      "The last time the condition transitioned from one status to another",
                    type: "string",
                    format: "date-time",
                  },
                  reason: {
                    description:
                      "A programmatic identifier indicating the reason for the condition's last transition",
                    type: "string",
                  },
                  message: {
                    description: "A human-readable message indicating details about the transition",
                    type: "string",
                  },
                },
              },
            },
            phase: {
              enum: ["Pending", "Ready", "Failed", "Retrying", "Removing", "RemovalFailed"],
              type: "string",
            },
            retryAttempt: {
              type: "integer",
              nullable: true,
            },
            nextRetryTime: {
              description: "ISO timestamp of when the next retry should occur",
              type: "string",
              format: "date-time",
              nullable: true,
            },
            clientId: {
              description: "The PocketID client ID after successful creation",
              type: "string",
            },
            secretName: {
              description: "Name of the Secret containing client credentials",
              type: "string",
            },
          },
        } as V1JSONSchemaProps,
        spec: specSchema,
      },
    },
  },
};

// The CRD definition for applying to the cluster
export const PocketIDClientCRD: V1CustomResourceDefinition = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: {
    name: "pocketidclients.jeffrescignano.io",
  },
  spec: {
    group: "jeffrescignano.io",
    scope: "Namespaced",
    names: {
      plural: "pocketidclients",
      singular: "pocketidclient",
      kind: "PocketIDClient",
      shortNames: ["pidc"],
    },
    versions: [v1alpha1],
  },
};
