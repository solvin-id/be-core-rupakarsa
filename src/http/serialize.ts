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
import type {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toGeneration(row: GenerationRow): GenerationDto {
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
    referenceImageUrl: row.referenceImageUrl,
    selectedParams: row.selectedParams,
    tokensCharged: row.tokensCharged,
    status: row.status,
    externalJobId: row.externalJobId,
    outputUrl: row.outputUrl,
    errorMessage: row.errorMessage,
    refunded: row.refunded,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export function toProvider(row: AiProviderRow): AiProviderDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKeyMasked: row.apiKeyMasked,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toModel(row: AiModelRow): AiModelDto {
  return {
    id: row.id,
    providerId: row.providerId,
    code: row.code,
    displayName: row.displayName,
    mediaType: row.mediaType,
    allowedParams: row.allowedParams,
    tokenCost: row.tokenCost,
    isActive: row.isActive,
  };
}
