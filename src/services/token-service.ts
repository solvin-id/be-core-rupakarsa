import { eq } from "drizzle-orm";

import type { Tx } from "../db/client.js";
import { planUsages, tokenLedger, workspaces } from "../db/schema.js";
import type { WorkspaceRow } from "../db/schema.js";
import { conflict } from "../http/errors.js";

interface ActorInput {
  workspaceId: string;
  userId: string | null;
  generationId?: string | null;
}

async function lockWorkspace(tx: Tx, workspaceId: string): Promise<WorkspaceRow> {
  const [row] = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update")
    .limit(1);
  if (!row) throw conflict("Workspace tidak ditemukan.");
  return row;
}

export async function holdTokens(
  tx: Tx,
  input: ActorInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const workspace = await lockWorkspace(tx, input.workspaceId);
  if (workspace.tokenBalance < input.amount) {
    throw conflict("Saldo token tidak cukup.");
  }
  const balanceAfter = workspace.tokenBalance - input.amount;

  await tx.update(workspaces).set({ tokenBalance: balanceAfter }).where(eq(workspaces.id, workspace.id));
  await tx.insert(tokenLedger).values({
    workspaceId: workspace.id,
    userId: input.userId,
    generationId: input.generationId ?? null,
    txType: "HOLD",
    amount: -input.amount,
    balanceAfter,
    notes: null,
  });

  return { balanceAfter };
}

export async function commitHold(tx: Tx, input: ActorInput & { amount: number }): Promise<void> {
  const workspace = await lockWorkspace(tx, input.workspaceId);
  await tx.insert(tokenLedger).values({
    workspaceId: workspace.id,
    userId: input.userId,
    generationId: input.generationId ?? null,
    txType: "COMMIT",
    amount: 0,
    balanceAfter: workspace.tokenBalance,
    notes: `${input.amount} token terpakai`,
  });
}

export async function refundHold(
  tx: Tx,
  input: ActorInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const workspace = await lockWorkspace(tx, input.workspaceId);
  const balanceAfter = workspace.tokenBalance + input.amount;

  await tx.update(workspaces).set({ tokenBalance: balanceAfter }).where(eq(workspaces.id, workspace.id));
  await tx.insert(tokenLedger).values({
    workspaceId: workspace.id,
    userId: input.userId,
    generationId: input.generationId ?? null,
    txType: "REFUND",
    amount: input.amount,
    balanceAfter,
    notes: null,
  });

  return { balanceAfter };
}

export async function topUpWorkspace(
  tx: Tx,
  input: { workspaceId: string; actorId: string | null; tokens: number; plan: number },
): Promise<WorkspaceRow> {
  const workspace = await lockWorkspace(tx, input.workspaceId);
  const tokenBalance = workspace.tokenBalance + input.tokens;
  const freePlanRemaining = workspace.freePlanRemaining + input.plan;

  const [updated] = await tx
    .update(workspaces)
    .set({ tokenBalance, freePlanRemaining })
    .where(eq(workspaces.id, workspace.id))
    .returning();
  if (!updated) throw conflict("Workspace tidak ditemukan.");

  if (input.tokens > 0) {
    await tx.insert(tokenLedger).values({
      workspaceId: workspace.id,
      userId: input.actorId,
      generationId: null,
      txType: "TOPUP",
      amount: input.tokens,
      balanceAfter: tokenBalance,
      notes: input.plan > 0 ? `plan:+${input.plan}` : null,
    });
  }

  return updated;
}

export async function consumePlanQuota(
  tx: Tx,
  input: { workspaceId: string; userId: string; planModeTokenCost: number },
): Promise<{ tokens: number; usesFreeQuota: boolean }> {
  const workspace = await lockWorkspace(tx, input.workspaceId);

  if (workspace.freePlanRemaining > 0) {
    const [updated] = await tx
      .update(workspaces)
      .set({ freePlanRemaining: workspace.freePlanRemaining - 1 })
      .where(eq(workspaces.id, workspace.id))
      .returning();
    if (!updated) throw conflict("Workspace tidak ditemukan.");

    await tx.insert(planUsages).values({
      workspaceId: workspace.id,
      userId: input.userId,
      usedFreeQuota: true,
      tokensCharged: 0,
    });

    return { tokens: 0, usesFreeQuota: true };
  }

  await holdTokens(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    amount: input.planModeTokenCost,
  });
  await commitHold(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    amount: input.planModeTokenCost,
  });

  await tx.insert(planUsages).values({
    workspaceId: workspace.id,
    userId: input.userId,
    usedFreeQuota: false,
    tokensCharged: input.planModeTokenCost,
  });

  return { tokens: input.planModeTokenCost, usesFreeQuota: false };
}
