import { z } from "@hono/zod-openapi";

export const RoleSchema = z.enum(["USER", "SUPERADMIN"]);
export const WorkspaceRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);
export const JoinRequestStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export const MediaTypeSchema = z.enum(["VIDEO", "IMAGE"]);
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
    referenceImageUrl: z.string().nullable(),
    selectedParams: GenerationParamsSchema,
    tokensCharged: z.number().int(),
    status: GenerationStatusSchema,
    externalJobId: z.string().nullable(),
    outputUrl: z.string().nullable(),
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
    mediaType: MediaTypeSchema,
    allowedParams: ModelAllowedParamsSchema,
    tokenCost: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("AiModel");

export const AiProviderSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    apiKeyMasked: z.string(),
    isActive: z.boolean(),
    updatedAt: z.string(),
  })
  .openapi("AiProvider");

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
    url: z.string(),
    mime: z.string(),
    size: z.number().int(),
  })
  .openapi("UploadResponse");

export const ModelTemplateSchema = z
  .object({
    providerCode: z.string(),
    code: z.string(),
    displayName: z.string(),
    mediaType: MediaTypeSchema,
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
    status: z.literal("ok"),
    db: z.boolean(),
  })
  .openapi("Health");

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
