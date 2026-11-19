import type {
  AiModelRow,
  AiProviderRow,
  FolderRow,
  GenerationRow,
  UserRow,
  WorkspaceJoinRequestRow,
  WorkspaceMembershipRow,
  WorkspaceRow,
} from "../db/schema.js";
import type { RenderProgress } from "../services/progress-service.js";
import { outputUrlFor } from "../services/storage-service.js";
import type {
  ActiveGenerationDto,
  AiModelDto,
  AiProviderDto,
  FolderDto,
  GenerationDto,
  JoinRequestDto,
  MemberSummaryDto,
  MembershipDto,
  RequestSummaryDto,
  UserDto,
  WorkspaceDto,
} from "./schemas.js";

export interface UserSummary {
  id: string;
  fullName: string;
  email: string;
}

export function toUser(row: UserRow): UserDto {
  return {
    id: row.id,
    defaultWorkspaceId: row.defaultWorkspaceId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    cmsAccess: row.cmsAccess,
    isActive: row.isActive,
    totpEnabled: row.totpEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toUserSummary(row: Pick<UserRow, "id" | "fullName" | "email">): UserSummary {
  return { id: row.id, fullName: row.fullName, email: row.email };
}

export function toWorkspace(row: WorkspaceRow): WorkspaceDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tokenBalance: row.tokenBalance,
    freePlanRemaining: row.freePlanRemaining,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMembership(row: WorkspaceMembershipRow): MembershipDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

export function toMemberSummary(
  row: WorkspaceMembershipRow,
  user: Pick<UserRow, "id" | "fullName" | "email">,
): MemberSummaryDto {
  return { ...toMembership(row), user: toUserSummary(user) };
}

export function toJoinRequest(row: WorkspaceJoinRequestRow): JoinRequestDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedByUserId: row.resolvedByUserId,
  };
}

export function toRequestSummary(
  row: WorkspaceJoinRequestRow,
  user: Pick<UserRow, "id" | "fullName" | "email">,
): RequestSummaryDto {
  return { ...toJoinRequest(row), user: toUserSummary(user) };
}

export function toFolder(row: FolderRow): FolderDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    characterReferenceId: row.characterReferenceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** URLs are derived here, never read from a column: old hostnames cannot strand a render. */
export function toGeneration(
  row: GenerationRow,
  outputPurgedAt: Date | null = null,
  progress: RenderProgress = { estimateMs: null, progressPercent: 0 },
): GenerationDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    userId: row.userId,
    modelId: row.modelId,
    modelName: row.modelName,
    mediaType: row.mediaType,
    rawPrompt: row.rawPrompt,
    plannedPrompt: row.plannedPrompt,
    planMode: row.planMode,
    finalPrompt: row.finalPrompt,
    analysisSnapshot: row.analysisSnapshot,
    preContextSnapshot: row.preContextSnapshot,
    referenceImageUrl: row.referenceImageUrl,
    sequence: row.sequence,
    selectedParams: row.selectedParams,
    tokensCharged: row.tokensCharged,
    status: row.status,
    externalJobId: row.externalJobId,
    outputUrl: outputUrlFor(row),
    outputMime: row.outputMime,
    outputSize: row.outputSize,
    outputPurgedAt: outputPurgedAt ? outputPurgedAt.toISOString() : null,
    errorMessage: row.errorMessage,
    refunded: row.refunded,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    providerStatus: row.providerStatus,
    promptCompressed: row.promptCompressed,
    promptLimitChars: row.promptLimitChars,
    estimateMs: progress.estimateMs,
    progressPercent: progress.progressPercent,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/** Notification-bell projection: the generation plus the folder name the studio links back to. */
export function toActiveGeneration(
  row: GenerationRow,
  folderName: string,
  progress: RenderProgress,
): ActiveGenerationDto {
  return {
    id: row.id,
    folderId: row.folderId,
    folderName,
    modelName: row.modelName,
    mediaType: row.mediaType,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    providerStatus: row.providerStatus,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    tokensCharged: row.tokensCharged,
    errorMessage: row.errorMessage,
    estimateMs: progress.estimateMs,
    progressPercent: progress.progressPercent,
  };
}

export function toProvider(row: AiProviderRow): AiProviderDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKeyMasked: row.apiKeyMasked,
    kind: row.kind,
    isFixed: row.isFixed,
    modelsPath: row.modelsPath,
    supportsVideoInput: row.supportsVideoInput,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    syncError: row.syncError,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toModel(row: AiModelRow, isDefault = false): AiModelDto {
  return {
    id: row.id,
    providerId: row.providerId,
    mediaType: row.mediaType,
    code: row.code,
    displayName: row.displayName,
    providerModelId: row.providerModelId,
    inputCapabilities: row.inputCapabilities,
    outputCapabilities: row.outputCapabilities,
    source: row.source,
    allowedParams: row.allowedParams,
    tokenCost: row.tokenCost,
    maxPromptChars: row.maxPromptChars,
    thinkingEnabled: row.thinkingEnabled,
    customReferenceId: row.customReferenceId,
    isActive: row.isActive,
    isDefault,
  };
}
