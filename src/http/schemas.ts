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
    /** Position of the render inside its folder; the scene chain orders on it. */
    sequence: z.number().int(),
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
    startedAt: z.string().nullable(),
    providerStatus: z.string().nullable(),
    promptCompressed: z.boolean(),
    promptLimitChars: z.number().int().nullable(),
    estimateMs: z.number().int().nullable(),
    progressPercent: z.number().int().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi("Generation");

/** Compact row for the notification bell: only what an in-flight badge needs. */
export const ActiveGenerationSchema = z
  .object({
    id: z.string(),
    folderId: z.string(),
    folderName: z.string(),
    modelName: z.string(),
    mediaType: MediaTypeSchema,
    status: GenerationStatusSchema,
    startedAt: z.string().nullable(),
    providerStatus: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    tokensCharged: z.number().int(),
    errorMessage: z.string().nullable(),
    estimateMs: z.number().int().nullable(),
    progressPercent: z.number().int().nullable(),
  })
  .openapi("ActiveGeneration");

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
    maxPromptChars: z.number().int().nullable(),
    thinkingEnabled: z.boolean(),
    customReferenceId: z.string().nullable(),
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

/** A wired AI model, as the studio needs it to decide which inputs are accepted. */
export const PublicModelRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  inputCapabilities: z.array(MediaCapabilitySchema),
});

export const PublicConfigSchema = z
  .object({
    contact: AdminContactSchema,
    pricing: PricingSchema,
    features: z.object({ simulation: z.boolean() }),
    planModel: PublicModelRefSchema.nullable(),
    /**
     * Analysis models are their own capability gate: attachment analysis and project-context media
     * never touch the plan model, so the studio cannot infer them from `planModel`.
     */
    analysisModels: z.object({
      image: PublicModelRefSchema.nullable(),
      video: PublicModelRefSchema.nullable(),
    }),
    defaults: z.object({ videoModelId: z.string().nullable() }),
    limits: z.object({
      planPromptMaxChars: z.number().int(),
      finalPromptMaxChars: z.number().int(),
    }),
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
    limit: z.object({ promptChars: z.number().int() }),
  })
  .openapi("PlanResponse");

export const LimitsSettingsSchema = z
  .object({
    generationsPerDayPerWorkspace: z.number().int(),
    planRequestsPerHourPerUser: z.number().int(),
    planPromptMaxChars: z.number().int(),
    finalPromptMaxChars: z.number().int(),
  })
  .openapi("LimitsSettings");

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

export const AiActivityKindSchema = z.enum([
  "PLAN",
  "ANALYSIS",
  "COMPRESS",
  "RENDER_SUBMIT",
  "RENDER_STATUS",
  "RENDER_COMPLETE",
  "RENDER_FAIL",
  "MODEL_SYNC",
  "PROVIDER_TEST",
  "CHARACTER_TRAIN",
]);

export const AiActivityStatusSchema = z.enum(["SUCCESS", "ERROR", "PENDING"]);

export const AiActivitySchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    workspaceName: z.string().nullable(),
    userId: z.string().nullable(),
    folderId: z.string().nullable(),
    generationId: z.string().nullable(),
    kind: AiActivityKindSchema,
    status: AiActivityStatusSchema,
    providerId: z.string().nullable(),
    providerName: z.string().nullable(),
    modelId: z.string().nullable(),
    modelName: z.string(),
    mediaType: MediaTypeSchema.nullable(),
    latencyMs: z.number().int(),
    promptChars: z.number().int(),
    responseChars: z.number().int(),
    tokensUsed: z.number().int(),
    externalJobId: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    requestText: z.string(),
    responseText: z.string(),
    metadata: z.record(z.unknown()),
    createdAt: z.string(),
  })
  .openapi("AiActivity");

export const AiActivityStatsSchema = z.object({
  total: z.number().int(),
  success: z.number().int(),
  error: z.number().int(),
  avgLatencyMs: z.number().int(),
  tokensUsed: z.number().int(),
});

export const AiActivityPageSchema = z
  .object({
    rows: z.array(AiActivitySchema),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    stats: AiActivityStatsSchema,
  })
  .openapi("AiActivityPage");

export const AiCharacterReferenceSchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    name: z.string(),
    modelVersion: z.string(),
    externalId: z.string().nullable(),
    status: z.enum(["NOT_READY", "QUEUED", "IN_PROGRESS", "COMPLETED", "FAILED"]),
    thumbnailUrl: z.string().nullable(),
    failReason: z.string().nullable(),
    inputImageUrls: z.array(z.string()),
    createdByUserId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi("AiCharacterReference");

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
export type ActiveGenerationDto = z.infer<typeof ActiveGenerationSchema>;
export type GenerationParamsDto = z.infer<typeof GenerationParamsSchema>;
export type AiModelDto = z.infer<typeof AiModelSchema>;
export type AiProviderDto = z.infer<typeof AiProviderSchema>;
export type AdminContactDto = z.infer<typeof AdminContactSchema>;
export type PricingDto = z.infer<typeof PricingSchema>;
export type PublicConfigDto = z.infer<typeof PublicConfigSchema>;
export type PlanResponseDto = z.infer<typeof PlanResponseSchema>;
export type LimitsSettingsDto = z.infer<typeof LimitsSettingsSchema>;
export type CreateGenerationResponseDto = z.infer<typeof CreateGenerationResponseSchema>;
export type UploadResponseDto = z.infer<typeof UploadResponseSchema>;
export type ModelTemplateDto = z.infer<typeof ModelTemplateSchema>;
export type ProviderTestDto = z.infer<typeof ProviderTestSchema>;
export type AccountCreatedDto = z.infer<typeof AccountCreatedSchema>;
export type AdminWorkspacesDto = z.infer<typeof AdminWorkspacesSchema>;
export type HealthDto = z.infer<typeof HealthSchema>;
export type AiActivityDto = z.infer<typeof AiActivitySchema>;
export type AiActivityPageDto = z.infer<typeof AiActivityPageSchema>;
export type AiCharacterReferenceDto = z.infer<typeof AiCharacterReferenceSchema>;
