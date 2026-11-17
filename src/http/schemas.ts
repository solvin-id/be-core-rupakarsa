import { z } from "@hono/zod-openapi";

export const RoleSchema = z.enum(["USER", "SUPERADMIN"]);
export const WorkspaceRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);
export const JoinRequestStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export const MediaTypeSchema = z.enum(["VIDEO", "IMAGE"]);
/** `ai_models.media_type` also stores TEXT so plan/analysis models live in the same catalog. */
export const ModelMediaTypeSchema = z.enum(["VIDEO", "IMAGE", "TEXT"]);
export type ModelMediaType = z.infer<typeof ModelMediaTypeSchema>;
export const MediaCapabilitySchema = z.enum(["TEXT", "IMAGE", "VIDEO"]);
export const GenerationStatusSchema = z.enum(["QUEUED", "RENDERING", "COMPLETED", "FAILED"]);

export const UserSchema = z
  .object({
    id: z.string(),
    defaultWorkspaceId: z.string().nullable(),
    email: z.string(),
    fullName: z.string(),
    role: RoleSchema,
    cmsAccess: z.boolean(),
    isActive: z.boolean(),
    totpEnabled: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("User");

export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    tokenBalance: z.number().int(),
    freePlanRemaining: z.number().int(),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Workspace");

export const WorkspaceMembershipSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    role: WorkspaceRoleSchema,
    joinedAt: z.string(),
  })
  .openapi("WorkspaceMembership");

export const UserSummarySchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
});

export const WorkspaceMemberSummarySchema = WorkspaceMembershipSchema.extend({
  user: UserSummarySchema,
}).openapi("WorkspaceMemberSummary");

export const WorkspaceJoinRequestSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    message: z.string(),
    status: JoinRequestStatusSchema,
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolvedByUserId: z.string().nullable(),
  })
  .openapi("WorkspaceJoinRequest");

export const WorkspaceRequestSummarySchema = WorkspaceJoinRequestSchema.extend({
  user: UserSummarySchema,
}).openapi("WorkspaceRequestSummary");

export const WorkspaceRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const MyJoinRequestSchema = WorkspaceJoinRequestSchema.extend({
  workspace: WorkspaceRefSchema,
}).openapi("MyJoinRequest");

export const SessionPayloadSchema = z
  .object({
    user: UserSchema,
    workspace: WorkspaceSchema,
    memberships: z.array(WorkspaceMembershipSchema),
    workspaces: z.array(WorkspaceSchema),
    activeWorkspaceRole: WorkspaceRoleSchema,
  })
  .openapi("SessionPayload");

export const LoginResponseSchema = z
  .union([
    SessionPayloadSchema,
    z.object({ totpRequired: z.literal(true), challengeToken: z.string() }),
  ])
  .openapi("LoginResponse");

export const TotpEnrollmentSchema = z
  .object({
    secret: z.string(),
    otpauthUrl: z.string(),
    qrDataUrl: z.string(),
  })
  .openapi("TotpEnrollment");

export const WorkspacesPayloadSchema = z
  .object({
    workspaces: z.array(WorkspaceSchema),
    memberships: z.array(WorkspaceMembershipSchema),
    manageableRequests: z.array(WorkspaceRequestSummarySchema),
    myRequests: z.array(MyJoinRequestSchema),
  })
  .openapi("WorkspacesPayload");

export const FolderSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string().nullable(),
    name: z.string(),
    description: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Folder");

export const FolderWithStatsSchema = FolderSchema.extend({
  videoCount: z.number().int(),
  imageCount: z.number().int(),
  tokensUsed: z.number().int(),
}).openapi("FolderWithStats");

export const ContextSourceSchema = z.enum(["TEXT", "UPLOAD", "GENERATION"]);

export const FolderContextSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    folderId: z.string(),
    source: ContextSourceSchema,
    label: z.string(),
    text: z.string(),
    mediaAssetId: z.string().nullable(),
    generationId: z.string().nullable(),
    createdByUserId: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("FolderContext");

export const AssetAnalysisSchema = z
  .object({
    sourceKind: z.enum(["UPLOAD", "GENERATION"]),
    sourceId: z.string(),
    text: z.string(),
    structured: z.record(z.unknown()),
    modelId: z.string().nullable(),
    cached: z.boolean(),
  })
  .openapi("AssetAnalysis");

export const GenerationParamsSchema = z.object({
  durationSec: z.number().int().optional(),
  resolution: z.string(),
  aspectRatio: z.string(),
});

export const GenerationSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    folderId: z.string(),
    userId: z.string().nullable(),
    modelId: z.string().nullable(),
    modelName: z.string(),
    mediaType: MediaTypeSchema,
    rawPrompt: z.string(),
    plannedPrompt: z.string(),
    planMode: z.boolean(),
    finalPrompt: z.string(),
    analysisSnapshot: z.string(),
    preContextSnapshot: z.string(),
    referenceImageUrl: z.string().nullable(),
    selectedParams: GenerationParamsSchema,
    tokensCharged: z.number().int(),
    status: GenerationStatusSchema,
    externalJobId: z.string().nullable(),
    outputUrl: z.string().nullable(),
    outputMime: z.string().nullable(),
    outputSize: z.number().int(),
    outputPurgedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    refunded: z.boolean(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi("Generation");

export const ModelAllowedParamsSchema = z.object({
  durations: z.array(z.number().int()).optional(),
  resolutions: z.array(z.string()),
  aspectRatios: z.array(z.string()),
});

export const AiModelSchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    code: z.string(),
    displayName: z.string(),
    providerModelId: z.string(),
    mediaType: ModelMediaTypeSchema,
    inputCapabilities: z.array(MediaCapabilitySchema),
    outputCapabilities: z.array(MediaCapabilitySchema),
    source: z.string(),
    allowedParams: ModelAllowedParamsSchema,
    tokenCost: z.number().int(),
    isActive: z.boolean(),
    isDefault: z.boolean(),
  })
  .openapi("AiModel");

export const AiProviderSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    apiKeyMasked: z.string(),
    kind: z.enum(["HIGGSFIELD", "OPENAI_COMPATIBLE"]),
    isFixed: z.boolean(),
    modelsPath: z.string(),
    supportsVideoInput: z.boolean(),
    lastSyncedAt: z.string().nullable(),
    syncError: z.string().nullable(),
    isActive: z.boolean(),
    updatedAt: z.string(),
  })
  .openapi("AiProvider");

export const RemoteModelSchema = z
  .object({
    providerModelId: z.string(),
    displayName: z.string(),
    inputCapabilities: z.array(MediaCapabilitySchema),
    outputCapabilities: z.array(MediaCapabilitySchema),
    mediaType: ModelMediaTypeSchema,
    durations: z.array(z.number().int()),
    resolutions: z.array(z.string()),
  })
  .openapi("RemoteModel");

export const SyncResultSchema = z
  .object({
    added: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    models: z.array(AiModelSchema),
  })
  .openapi("SyncResult");

export const AdminContactSchema = z
  .object({
    name: z.string(),
    whatsapp: z.string(),
    email: z.string(),
  })
  .openapi("AdminContact");

export const PricingSchema = z
  .object({
    tokenValueRupiah: z.number().int(),
    packageTokens: z.number().int(),
    packagePlanQuota: z.number().int(),
    planModeTokenCost: z.number().int(),
  })
  .openapi("Pricing");

export const PublicConfigSchema = z
  .object({
    contact: AdminContactSchema,
    pricing: PricingSchema,
    features: z.object({ simulation: z.boolean() }),
    planModel: z
      .object({
        id: z.string(),
        name: z.string(),
        inputCapabilities: z.array(MediaCapabilitySchema),
      })
      .nullable(),
    defaults: z.object({ videoModelId: z.string().nullable() }),
  })
  .openapi("PublicConfig");

export const PlanBlueprintSchema = z.object({
  prompt: z.string(),
  direction: z.string(),
  negativePrompt: z.string(),
});

export const PlanCostSchema = z.object({
  tokens: z.number().int(),
  usesFreeQuota: z.boolean(),
});

export const PlanResponseSchema = z
  .object({
    blueprint: PlanBlueprintSchema,
    cost: PlanCostSchema,
    workspace: WorkspaceSchema,
    analysis: z.object({
      attachments: z.array(z.object({ key: z.string(), text: z.string() })),
      preContext: z.string(),
    }),
  })
  .openapi("PlanResponse");

export const CreateGenerationResponseSchema = z
  .object({
    generation: GenerationSchema,
    workspace: WorkspaceSchema,
  })
  .openapi("CreateGenerationResponse");

export const UploadResponseSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    key: z.string(),
    mime: z.string(),
    size: z.number().int(),
    durationMs: z.number().int().nullable(),
  })
  .openapi("UploadResponse");

export const ModelTemplateSchema = z
  .object({
    providerCode: z.string(),
    code: z.string(),
    displayName: z.string(),
    mediaType: ModelMediaTypeSchema,
    allowedParams: ModelAllowedParamsSchema,
    tokenCost: z.number().int(),
  })
  .openapi("ModelTemplate");

export const ProviderTestSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
  })
  .openapi("ProviderTest");

export const AccountCreatedSchema = z
  .object({
    account: UserSchema,
    temporaryPassword: z.string(),
  })
  .openapi("AccountCreated");

export const AdminWorkspacesSchema = z
  .object({
    workspaces: z.array(WorkspaceSchema),
    memberships: z.array(WorkspaceMemberSummarySchema),
  })
  .openapi("AdminWorkspaces");

export const HealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    db: z.boolean(),
    redis: z.boolean(),
    worker: z.boolean(),
  })
  .openapi("Health");

export const StorageDriverSchema = z.enum(["local", "s3"]);
export const WorkspaceStorageKindSchema = z.enum(["local", "s3", "gdrive"]);

export const StorageSettingsSchema = z
  .object({
    driver: StorageDriverSchema,
    retentionDays: z.number().int(),
    s3: z.object({
      endpoint: z.string(),
      region: z.string(),
      bucket: z.string(),
      accessKeyId: z.string(),
      publicBaseUrl: z.string(),
      forcePathStyle: z.boolean(),
      secretAccessKeyMasked: z.string(),
    }),
    gdrive: z.object({
      clientId: z.string(),
      clientSecretMasked: z.string(),
      redirectUri: z.string(),
      configured: z.boolean(),
    }),
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        driveConnected: z.boolean(),
        googleEmail: z.string(),
        folderIdMasked: z.string(),
        folderUrl: z.string(),
        lastError: z.string().nullable(),
        connectedAt: z.string().nullable(),
      }),
    ),
  })
  .openapi("StorageSettings");

export const StorageUsageSchema = z
  .object({
    active: z.number().int(),
    bytes: z.number().int(),
    expired: z.number().int(),
  })
  .openapi("StorageUsage");

export const StorageItemSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    driver: WorkspaceStorageKindSchema,
    source: z.enum(["UPLOAD", "GENERATION"]),
    url: z.string(),
    generationId: z.string().nullable(),
    modelName: z.string().nullable(),
    createdAt: z.string(),
    purgedAt: z.string().nullable(),
  })
  .openapi("StorageItem");

export const StorageListSchema = z
  .object({
    items: z.array(StorageItemSchema),
    nextCursor: z.string().nullable(),
    totals: z.object({
      count: z.number().int(),
      bytes: z.number().int(),
      images: z.number().int(),
      videos: z.number().int(),
    }),
  })
  .openapi("StorageList");

export const WorkspaceDriveSchema = z
  .object({
    connected: z.boolean(),
    oauthConfigured: z.boolean(),
    googleEmail: z.string(),
    folderId: z.string(),
    folderName: z.string(),
    folderUrl: z.string(),
    connectedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    defaultStorage: z.object({
      kind: z.enum(["s3", "local"]),
      retentionDays: z.number().int(),
    }),
  })
  .openapi("WorkspaceDrive");

export const DriveStartSchema = z.object({ url: z.string() }).openapi("DriveStart");

export const MailSettingsSchema = z
  .object({
    driver: z.enum(["smtp", "log"]),
    fromName: z.string(),
    fromEmail: z.string(),
    smtp: z.object({
      host: z.string(),
      port: z.number().int(),
      secure: z.boolean(),
      user: z.string(),
      passwordMasked: z.string(),
    }),
  })
  .openapi("MailSettings");

export const PackageSchema = z
  .object({
    id: z.string(),
    tokens: z.number().int(),
    planQuota: z.number().int(),
    priceRupiah: z.number().int(),
  })
  .openapi("Package");

export const OrderSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string().nullable(),
    tokens: z.number().int(),
    planQuota: z.number().int(),
    amountRupiah: z.number().int(),
    provider: z.string(),
    providerRef: z.string().nullable(),
    status: z.enum(["PENDING", "PAID", "EXPIRED", "FAILED"]),
    paidAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Order");

export const CreateOrderResponseSchema = z
  .object({
    order: OrderSchema,
    redirectUrl: z.string().nullable(),
  })
  .openapi("CreateOrderResponse");

export const CmsOrderSchema = OrderSchema.extend({
  workspaceName: z.string(),
}).openapi("CmsOrder");

export const AuditLogSchema = z
  .object({
    id: z.string(),
    actorUserId: z.string().nullable(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    metadata: z.record(z.unknown()),
    ip: z.string(),
    createdAt: z.string(),
  })
  .openapi("AuditLog");

export const ErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .openapi("ErrorResponse");

export type UserDto = z.infer<typeof UserSchema>;
export type WorkspaceDto = z.infer<typeof WorkspaceSchema>;
export type MembershipDto = z.infer<typeof WorkspaceMembershipSchema>;
export type MemberSummaryDto = z.infer<typeof WorkspaceMemberSummarySchema>;
export type JoinRequestDto = z.infer<typeof WorkspaceJoinRequestSchema>;
export type RequestSummaryDto = z.infer<typeof WorkspaceRequestSummarySchema>;
export type MyJoinRequestDto = z.infer<typeof MyJoinRequestSchema>;
export type SessionPayloadDto = z.infer<typeof SessionPayloadSchema>;
export type WorkspacesPayloadDto = z.infer<typeof WorkspacesPayloadSchema>;
export type FolderDto = z.infer<typeof FolderSchema>;
export type FolderWithStatsDto = z.infer<typeof FolderWithStatsSchema>;
export type GenerationDto = z.infer<typeof GenerationSchema>;
export type GenerationParamsDto = z.infer<typeof GenerationParamsSchema>;
export type AiModelDto = z.infer<typeof AiModelSchema>;
export type AiProviderDto = z.infer<typeof AiProviderSchema>;
export type AdminContactDto = z.infer<typeof AdminContactSchema>;
export type PricingDto = z.infer<typeof PricingSchema>;
export type PublicConfigDto = z.infer<typeof PublicConfigSchema>;
export type PlanResponseDto = z.infer<typeof PlanResponseSchema>;
export type CreateGenerationResponseDto = z.infer<typeof CreateGenerationResponseSchema>;
export type UploadResponseDto = z.infer<typeof UploadResponseSchema>;
export type ModelTemplateDto = z.infer<typeof ModelTemplateSchema>;
export type ProviderTestDto = z.infer<typeof ProviderTestSchema>;
export type AccountCreatedDto = z.infer<typeof AccountCreatedSchema>;
export type AdminWorkspacesDto = z.infer<typeof AdminWorkspacesSchema>;
export type HealthDto = z.infer<typeof HealthSchema>;
