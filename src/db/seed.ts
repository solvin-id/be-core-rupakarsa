import { eq } from "drizzle-orm";

import { hashPassword } from "../auth/password.js";
import type { Tx } from "./client.js";
import { db, closeDb } from "./client.js";
import {
  aiModels,
  aiProviders,
  folders,
  generations,
  tokenLedger,
  users,
  workspaceJoinRequests,
  workspaceMemberships,
  workspaces,
} from "./schema.js";
import type { GenerationParams } from "./schema.js";
import { env } from "../env.js";
import { buildPosterSvg } from "../adapters/stub-render.js";
import { getStorage } from "../storage/index.js";
import { MODEL_TEMPLATES } from "../services/model-catalog.js";
import {
  DEFAULT_CONTACT,
  DEFAULT_PRICING,
  SETTING_KEYS,
  writeSetting,
} from "../services/settings.js";

const IDS = {
  workspace: {
    rupakarsa: "00000000-0000-4000-8000-000000000001",
    alfateve: "00000000-0000-4000-8000-000000000002",
    demoStudio: "00000000-0000-4000-8000-000000000003",
    nadiaStudio: "00000000-0000-4000-8000-000000000004",
    bagasStudio: "00000000-0000-4000-8000-000000000005",
    lumiere: "00000000-0000-4000-8000-000000000006",
  },
  user: {
    demo: "00000000-0000-4000-8000-000000000101",
    nadia: "00000000-0000-4000-8000-000000000102",
    bagas: "00000000-0000-4000-8000-000000000103",
  },
  folder: {
    rasa: "00000000-0000-4000-8000-000000000201",
    senja: "00000000-0000-4000-8000-000000000202",
    lumiere: "00000000-0000-4000-8000-000000000203",
    arsip: "00000000-0000-4000-8000-000000000204",
  },
  request: {
    bagasLumiere: "00000000-0000-4000-8000-000000000301",
  },
} as const;

interface ProviderSeed {
  code: string;
  name: string;
  baseUrl: string;
}

const PROVIDERS: ProviderSeed[] = [
  { code: "HIGGSFIELD", name: "Higgsfield", baseUrl: "https://platform.higgsfield.ai" },
  { code: "KENARI_AI", name: "Kenari AI", baseUrl: "https://api.kenariai.com/v1" },
  { code: "R2", name: "Cloudflare R2", baseUrl: "https://rupakarsa.r2.cloudflarestorage.com" },
];

export async function seedPlatform(tx: Tx): Promise<void> {
  await writeSetting(tx, SETTING_KEYS.contact, DEFAULT_CONTACT);
  await writeSetting(tx, SETTING_KEYS.pricing, DEFAULT_PRICING);

  for (const provider of PROVIDERS) {
    await tx
      .insert(aiProviders)
      .values({
        code: provider.code,
        name: provider.name,
        baseUrl: provider.baseUrl,
        isActive: true,
      })
      .onConflictDoNothing({ target: aiProviders.code });
  }

  const providerRows = await tx.select().from(aiProviders);
  const higgsfield = providerRows.find((row) => row.code === "HIGGSFIELD");
  if (!higgsfield) throw new Error("Seed requires the HIGGSFIELD provider row.");

  for (const template of MODEL_TEMPLATES) {
    const provider =
      template.providerCode === "HIGGSFIELD"
        ? higgsfield
        : providerRows.find((row) => row.code === template.providerCode);
    if (!provider) continue;

    await tx
      .insert(aiModels)
      .values({
        providerId: provider.id,
        code: template.code,
        displayName: template.displayName,
        mediaType: template.mediaType,
        allowedParams: template.allowedParams,
        tokenCost: template.tokenCost,
        isActive: template.code !== "kling-2.6-pro",
      })
      .onConflictDoNothing({ target: [aiModels.providerId, aiModels.code] });
  }

  const superadminPasswordHash = await hashPassword(env.SEED_SUPERADMIN_PASSWORD);

  await tx
    .insert(workspaces)
    .values({
      id: IDS.workspace.rupakarsa,
      name: "Rupakarsa Workspace",
      slug: "rupakarsa-workspace",
    })
    .onConflictDoNothing({ target: workspaces.id });

  const [superadmin] = await tx
    .insert(users)
    .values({
      email: env.SEED_SUPERADMIN_EMAIL.toLowerCase(),
      passwordHash: superadminPasswordHash,
      fullName: "Superadmin Rupakarsa",
      role: "SUPERADMIN",
      cmsAccess: true,
      defaultWorkspaceId: IDS.workspace.rupakarsa,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        passwordHash: superadminPasswordHash,
        fullName: "Superadmin Rupakarsa",
        role: "SUPERADMIN",
        cmsAccess: true,
        isActive: true,
      },
    })
    .returning();
  if (!superadmin) throw new Error("Failed to seed the superadmin account.");

  await tx
    .update(users)
    .set({ defaultWorkspaceId: IDS.workspace.rupakarsa })
    .where(eq(users.id, superadmin.id));

  await tx
    .insert(workspaceMemberships)
    .values({
      workspaceId: IDS.workspace.rupakarsa,
      userId: superadmin.id,
      role: "OWNER",
    })
    .onConflictDoNothing({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    });
}

interface DemoAccountSeed {
  id: string;
  email: string;
  fullName: string;
  workspaceId: string;
}

const DEMO_ACCOUNTS: DemoAccountSeed[] = [
  {
    id: IDS.user.demo,
    email: "demo@rupakarsa.id",
    fullName: "Demo Kreator",
    workspaceId: IDS.workspace.alfateve,
  },
  {
    id: IDS.user.nadia,
    email: "nadia@alfateve.co.id",
    fullName: "Nadia Prameswari",
    workspaceId: IDS.workspace.alfateve,
  },
  {
    id: IDS.user.bagas,
    email: "bagas@alfateve.co.id",
    fullName: "Bagas Aditya",
    workspaceId: IDS.workspace.alfateve,
  },
];

interface DemoWorkspaceSeed {
  id: string;
  name: string;
  slug: string;
  tokenBalance: number;
  freePlanRemaining: number;
  createdAt: string;
}

const DEMO_WORKSPACES: DemoWorkspaceSeed[] = [
  {
    id: IDS.workspace.alfateve,
    name: "Alfateve",
    slug: "alfateve",
    tokenBalance: 4000,
    freePlanRemaining: 250,
    createdAt: "2026-09-20T08:00:00.000Z",
  },
  {
    id: IDS.workspace.demoStudio,
    name: "Demo Studio",
    slug: "demo-studio",
    tokenBalance: 0,
    freePlanRemaining: 0,
    createdAt: "2026-10-02T08:00:00.000Z",
  },
  {
    id: IDS.workspace.nadiaStudio,
    name: "Nadia Studio",
    slug: "nadia-studio",
    tokenBalance: 0,
    freePlanRemaining: 0,
    createdAt: "2026-10-08T09:30:00.000Z",
  },
  {
    id: IDS.workspace.bagasStudio,
    name: "Bagas Studio",
    slug: "bagas-studio",
    tokenBalance: 0,
    freePlanRemaining: 0,
    createdAt: "2026-10-11T11:15:00.000Z",
  },
  {
    id: IDS.workspace.lumiere,
    name: "Lumiere Lab",
    slug: "lumiere-lab",
    tokenBalance: 1200,
    freePlanRemaining: 50,
    createdAt: "2026-11-01T10:10:00.000Z",
  },
];

function membershipsForSuperadmin(superadminId: string) {
  return [
    { workspaceKeys: ["rupakarsa", "lumiere"] as const, userId: superadminId },
  ];
}

interface DemoFolderSeed {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

const DEMO_FOLDERS: DemoFolderSeed[] = [
  {
    id: IDS.folder.rasa,
    name: "Kampanye Rasa Nusantara",
    description:
      "Serial 5 video pendek untuk peluncuran bumbu rempah premium. Fokus pada tekstur, uap, dan warna hangat.",
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-11-14T10:02:00.000Z",
  },
  {
    id: IDS.folder.senja,
    name: "Film Pendek: Senja di Tegalsari",
    description: "Adaptasi cerita rakyat 4 shot. Narasi perempuan, suasana desa, dan penjara batu.",
    createdAt: "2026-10-24T13:20:00.000Z",
    updatedAt: "2026-11-15T08:30:00.000Z",
  },
  {
    id: IDS.folder.lumiere,
    name: "Product Launch: Lumiere",
    description: "Video produk 10 detik dan still image untuk paid ads.",
    createdAt: "2026-11-01T10:10:00.000Z",
    updatedAt: "2026-11-12T13:20:00.000Z",
  },
  {
    id: IDS.folder.arsip,
    name: "Arsip Eksperimen",
    description: "Uji coba prompt, referensi visual, dan look development.",
    createdAt: "2026-11-05T15:40:00.000Z",
    updatedAt: "2026-11-15T09:00:00.000Z",
  },
];

interface DemoGenerationSeed {
  id: string;
  folderId: string;
  modelCode: string;
  mediaType: "VIDEO" | "IMAGE";
  rawPrompt: string;
  plannedPrompt: string;
  referenceImageUrl: string | null;
  selectedParams: GenerationParams;
  tokensCharged: number;
  status: "COMPLETED" | "FAILED";
  externalJobId: string;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string;
}

const DEMO_GENERATIONS: DemoGenerationSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000000401",
    folderId: IDS.folder.rasa,
    modelCode: "wan-qwen-10s",
    mediaType: "VIDEO",
    rawPrompt:
      "Close-up uap dari semangkuk rendang yang baru diangkat dari tungku, rempah jatuh perlahan, cahaya pagi dari jendela kayu.",
    plannedPrompt:
      "Cinematic close-up, 10 seconds. Steam curls from a bowl of freshly lifted rendang as crushed spices fall in slow motion. Warm morning light cuts through a wooden window, dust motes visible. Shallow depth of field, 50mm lens, rich amber and deep brown palette, tactile food texture, subtle handheld drift.",
    referenceImageUrl: null,
    selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
    tokensCharged: 35,
    status: "COMPLETED",
    externalJobId: "hf_job_8f21a",
    errorMessage: null,
    createdAt: "2026-11-14T09:12:00.000Z",
    completedAt: "2026-11-14T09:14:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000402",
    folderId: IDS.folder.rasa,
    modelCode: "wan-qwen-5s",
    mediaType: "VIDEO",
    rawPrompt:
      "Tangan menaburkan bubuk rempah ke atas wajan panas, asap tipis naik, latar dapur tradisional yang gelap.",
    plannedPrompt:
      "Vertical 5-second insert. A hand sprinkles spice powder over a hot wok; a thin plume of smoke rises and catches a warm side light. Dark traditional kitchen background, macro texture, 85mm lens, rich contrast, slow motion at 60fps.",
    referenceImageUrl: null,
    selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "9:16" },
    tokensCharged: 18,
    status: "COMPLETED",
    externalJobId: "hf_job_2c90b",
    errorMessage: null,
    createdAt: "2026-11-14T10:02:00.000Z",
    completedAt: "2026-11-14T10:04:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000403",
    folderId: IDS.folder.rasa,
    modelCode: "flux-image",
    mediaType: "IMAGE",
    rawPrompt:
      "Still life rempah Nusantara di atas kain linen, cengkeh, kayu manis, dan cabai kering, cahaya samping lembut.",
    plannedPrompt:
      "Editorial still life of Indonesian spices on natural linen: cloves, cinnamon bark, dried chilies, star anise. Soft directional window light, deep shadows, warm earth palette, 4:5 crop, high detail, premium cookbook aesthetic.",
    referenceImageUrl: null,
    selectedParams: { resolution: "2k", aspectRatio: "4:5" },
    tokensCharged: 2,
    status: "COMPLETED",
    externalJobId: "hf_job_71d4e",
    errorMessage: null,
    createdAt: "2026-11-13T15:20:00.000Z",
    completedAt: "2026-11-13T15:21:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000404",
    folderId: IDS.folder.senja,
    modelCode: "wan-qwen-10s",
    mediaType: "VIDEO",
    rawPrompt:
      "Mbok Srini berjalan pelan di lorong penjara batu, membawa lentera, bayangan jeruji jatuh di wajahnya.",
    plannedPrompt:
      "Cinematic 10-second tracking shot. Mbok Srini, an elderly Javanese farmer in a faded batik shawl, walks slowly down a stone prison corridor carrying a lantern. Bar shadows slide across her weathered face. Cold blue stone against warm lantern light, 35mm lens, gentle handheld follow, dust in the air.",
    referenceImageUrl: null,
    selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
    tokensCharged: 35,
    status: "COMPLETED",
    externalJobId: "hf_job_5a12c",
    errorMessage: null,
    createdAt: "2026-11-15T08:30:00.000Z",
    completedAt: "2026-11-15T08:32:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000405",
    folderId: IDS.folder.senja,
    modelCode: "wan-qwen-5s",
    mediaType: "VIDEO",
    rawPrompt: "Close-up kunci besi tua di atas meja batu, tangan mengambilnya perlahan.",
    plannedPrompt:
      "Macro 5-second insert. A weathered iron key rests on a rough stone table; a hand enters frame and lifts it slowly. Single warm lantern source, deep shadows, shallow focus, 100mm macro lens, tactile rust texture.",
    referenceImageUrl: null,
    selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "16:9" },
    tokensCharged: 18,
    status: "FAILED",
    externalJobId: "hf_job_9b03f",
    errorMessage: "Content policy rejection dari provider. Token dikembalikan otomatis.",
    createdAt: "2026-11-14T16:45:00.000Z",
    completedAt: "2026-11-14T16:46:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000406",
    folderId: IDS.folder.senja,
    modelCode: "flux-image",
    mediaType: "IMAGE",
    rawPrompt:
      "Portrait Queen Bella, rambut perak panjang, mata biru, jubah navy dengan bordir emas, ekspresi tenang namun tajam.",
    plannedPrompt:
      "Regal portrait of Queen Bella: long silver-white hair, piercing blue eyes, navy robe with intricate gold embroidery, sheer cream outer layer, ornate sword at her side. Soft chiaroscuro lighting, dark stone background, 9:16 editorial fantasy portrait, ultra-detailed fabric.",
    referenceImageUrl: null,
    selectedParams: { resolution: "2k", aspectRatio: "9:16" },
    tokensCharged: 2,
    status: "COMPLETED",
    externalJobId: "hf_job_3e77a",
    errorMessage: null,
    createdAt: "2026-11-14T11:10:00.000Z",
    completedAt: "2026-11-14T11:11:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000407",
    folderId: IDS.folder.lumiere,
    modelCode: "wan-qwen-10s",
    mediaType: "VIDEO",
    rawPrompt:
      "Botol serum Lumiere berputar perlahan di atas podium hitam, cahaya studio lembut, refleksi emas.",
    plannedPrompt:
      "Premium product film, 10 seconds. A frosted glass serum bottle rotates slowly on a glossy black podium. Soft studio key light with a warm gold rim, controlled reflections, subtle mist, macro detail on the dropper. 16:9, 1080p, luxury skincare commercial language.",
    referenceImageUrl: null,
    selectedParams: { durationSec: 10, resolution: "1080p", aspectRatio: "16:9" },
    tokensCharged: 35,
    status: "COMPLETED",
    externalJobId: "hf_job_1d88b",
    errorMessage: null,
    createdAt: "2026-11-12T13:00:00.000Z",
    completedAt: "2026-11-12T13:02:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000408",
    folderId: IDS.folder.lumiere,
    modelCode: "flux-image",
    mediaType: "IMAGE",
    rawPrompt: "Product still Lumiere, botol serum, latar krem, bayangan lembut, minimalis.",
    plannedPrompt:
      "Minimal luxury product still: Lumiere serum bottle on a warm cream backdrop, soft directional shadow, subtle gold accents, generous negative space, 1:1 crop, editorial beauty campaign.",
    referenceImageUrl: null,
    selectedParams: { resolution: "2k", aspectRatio: "1:1" },
    tokensCharged: 2,
    status: "COMPLETED",
    externalJobId: "hf_job_6c21d",
    errorMessage: null,
    createdAt: "2026-11-12T13:20:00.000Z",
    completedAt: "2026-11-12T13:21:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000409",
    folderId: IDS.folder.arsip,
    modelCode: "wan-qwen-5s",
    mediaType: "VIDEO",
    rawPrompt: "Neon Jakarta, hujan, refleksi di aspal, kamera bergerak pelan ke arah keramaian.",
    plannedPrompt:
      "Vertical 5-second night shot. Neon Jakarta signage reflects on wet asphalt; the camera drifts slowly toward a crowded intersection. Cyan and magenta practical lights, anamorphic flares, rain texture, 9:16, cinematic urban mood.",
    referenceImageUrl: null,
    selectedParams: { durationSec: 5, resolution: "720p", aspectRatio: "9:16" },
    tokensCharged: 18,
    status: "COMPLETED",
    externalJobId: "hf_job_2ff31",
    errorMessage: null,
    createdAt: "2026-11-15T09:00:00.000Z",
    completedAt: "2026-11-15T09:02:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000410",
    folderId: IDS.folder.arsip,
    modelCode: "flux-image",
    mediaType: "IMAGE",
    rawPrompt: "Eksplorasi tekstur kertas daur ulang, lipatan, serat, cahaya hangat.",
    plannedPrompt:
      "Abstract material study: recycled paper surface with visible fibers, folds, and soft warm raking light. Neutral sand palette, high micro-detail, 1:1 crop, tactile editorial texture.",
    referenceImageUrl: null,
    selectedParams: { resolution: "1k", aspectRatio: "1:1" },
    tokensCharged: 2,
    status: "COMPLETED",
    externalJobId: "hf_job_4a90e",
    errorMessage: null,
    createdAt: "2026-11-11T10:00:00.000Z",
    completedAt: "2026-11-11T10:01:00.000Z",
  },
];

export async function seedDemo(tx: Tx): Promise<void> {
  const passwordHash = await hashPassword(env.DEMO_SEED_PASSWORD);

  for (const workspace of DEMO_WORKSPACES) {
    await tx
      .insert(workspaces)
      .values({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        tokenBalance: workspace.tokenBalance,
        freePlanRemaining: workspace.freePlanRemaining,
        createdAt: new Date(workspace.createdAt),
      })
      .onConflictDoNothing({ target: workspaces.id });
  }

  for (const account of DEMO_ACCOUNTS) {
    await tx
      .insert(users)
      .values({
        id: account.id,
        email: account.email,
        passwordHash,
        fullName: account.fullName,
        role: "USER",
        cmsAccess: false,
        isActive: true,
        defaultWorkspaceId: account.workspaceId,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, fullName: account.fullName, isActive: true },
      });
  }

  const membershipRows: Array<{ workspaceId: string; userId: string; role: "OWNER" | "ADMIN" | "MEMBER" }> = [
    { workspaceId: IDS.workspace.alfateve, userId: IDS.user.demo, role: "OWNER" },
    { workspaceId: IDS.workspace.alfateve, userId: IDS.user.nadia, role: "ADMIN" },
    { workspaceId: IDS.workspace.alfateve, userId: IDS.user.bagas, role: "MEMBER" },
    { workspaceId: IDS.workspace.demoStudio, userId: IDS.user.demo, role: "OWNER" },
    { workspaceId: IDS.workspace.nadiaStudio, userId: IDS.user.nadia, role: "OWNER" },
    { workspaceId: IDS.workspace.bagasStudio, userId: IDS.user.bagas, role: "OWNER" },
  ];

  for (const membership of membershipRows) {
    await tx
      .insert(workspaceMemberships)
      .values(membership)
      .onConflictDoNothing({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      });
  }

  const [superadmin] = await tx
    .select()
    .from(users)
    .where(eq(users.email, env.SEED_SUPERADMIN_EMAIL.toLowerCase()))
    .limit(1);
  if (!superadmin) throw new Error("seedDemo requires seedPlatform to run first.");

  for (const group of membershipsForSuperadmin(superadmin.id)) {
    for (const key of group.workspaceKeys) {
      await tx
        .insert(workspaceMemberships)
        .values({ workspaceId: IDS.workspace[key], userId: group.userId, role: "OWNER" })
        .onConflictDoNothing({
          target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
        });
    }
  }

  for (const folder of DEMO_FOLDERS) {
    await tx
      .insert(folders)
      .values({
        id: folder.id,
        workspaceId: IDS.workspace.alfateve,
        userId: IDS.user.demo,
        name: folder.name,
        description: folder.description,
        createdAt: new Date(folder.createdAt),
        updatedAt: new Date(folder.updatedAt),
      })
      .onConflictDoNothing({ target: folders.id });
  }

  const requestExists = await tx
    .select({ id: workspaceJoinRequests.id })
    .from(workspaceJoinRequests)
    .where(eq(workspaceJoinRequests.id, IDS.request.bagasLumiere))
    .limit(1);

  if (requestExists.length === 0) {
    await tx.insert(workspaceJoinRequests).values({
      id: IDS.request.bagasLumiere,
      workspaceId: IDS.workspace.lumiere,
      userId: IDS.user.bagas,
      message: "Bergabung untuk produksi kampanye Lumiere.",
      status: "PENDING",
      createdAt: new Date("2026-11-15T10:00:00.000Z"),
    });
  }

  const modelRows = await tx.select().from(aiModels);
  const modelByCode = new Map(modelRows.map((row) => [row.code, row]));
  const storage = getStorage();
  const useLocalMedia = env.STORAGE_DRIVER === "local";

  const existingGenerations = await tx
    .select({ id: generations.id })
    .from(generations)
    .where(eq(generations.workspaceId, IDS.workspace.alfateve));

  if (existingGenerations.length === 0) {
    for (const generation of DEMO_GENERATIONS) {
      const model = modelByCode.get(generation.modelCode);
      if (!model) continue;

      let outputUrl: string | null = null;
      if (generation.status === "COMPLETED" && useLocalMedia) {
        const key = `generations/${generation.id}.svg`;
        const svg = buildPosterSvg(generation.id, {
          prompt: generation.plannedPrompt,
          modelName: model.displayName,
          mediaType: generation.mediaType,
          selectedParams: generation.selectedParams,
        });
        await storage.put(key, Buffer.from(svg, "utf8"), "image/svg+xml");
        outputUrl = storage.url(key);
      }

      await tx.insert(generations).values({
        id: generation.id,
        workspaceId: IDS.workspace.alfateve,
        folderId: generation.folderId,
        userId: IDS.user.demo,
        modelId: model.id,
        modelName: model.displayName,
        mediaType: generation.mediaType,
        rawPrompt: generation.rawPrompt,
        plannedPrompt: generation.plannedPrompt,
        referenceImageUrl: generation.referenceImageUrl,
        selectedParams: generation.selectedParams,
        tokensCharged: generation.tokensCharged,
        status: generation.status,
        externalJobId: generation.externalJobId,
        outputUrl,
        errorMessage: generation.errorMessage,
        refunded: generation.status === "FAILED",
        createdAt: new Date(generation.createdAt),
        completedAt: new Date(generation.completedAt),
      });
    }
  }

  const ledgerExists = await tx
    .select({ id: tokenLedger.id })
    .from(tokenLedger)
    .where(eq(tokenLedger.workspaceId, IDS.workspace.alfateve))
    .limit(1);

  if (ledgerExists.length === 0) {
    const ordered = [...DEMO_GENERATIONS].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    let charged = 0;
    let refunded = 0;
    for (const generation of ordered) {
      charged += generation.tokensCharged;
      if (generation.status === "FAILED") refunded += generation.tokensCharged;
    }
    const afateve = DEMO_WORKSPACES[0]!;
    const initialBalance = afateve.tokenBalance + charged - refunded;

    let balance = initialBalance;
    await tx.insert(tokenLedger).values({
      workspaceId: afateve.id,
      userId: IDS.user.demo,
      txType: "TOPUP",
      amount: initialBalance,
      balanceAfter: balance,
      notes: `plan:+${afateve.freePlanRemaining}`,
      createdAt: new Date("2026-09-20T08:00:00.000Z"),
    });

    for (const generation of ordered) {
      balance -= generation.tokensCharged;
      await tx.insert(tokenLedger).values({
        workspaceId: afateve.id,
        userId: IDS.user.demo,
        generationId: generation.id,
        txType: "HOLD",
        amount: -generation.tokensCharged,
        balanceAfter: balance,
        createdAt: new Date(generation.createdAt),
      });

      if (generation.status === "FAILED") {
        balance += generation.tokensCharged;
        await tx.insert(tokenLedger).values({
          workspaceId: afateve.id,
          userId: IDS.user.demo,
          generationId: generation.id,
          txType: "REFUND",
          amount: generation.tokensCharged,
          balanceAfter: balance,
          createdAt: new Date(generation.completedAt),
        });
      } else {
        await tx.insert(tokenLedger).values({
          workspaceId: afateve.id,
          userId: IDS.user.demo,
          generationId: generation.id,
          txType: "COMMIT",
          amount: 0,
          balanceAfter: balance,
          notes: `${generation.tokensCharged} token terpakai`,
          createdAt: new Date(generation.completedAt),
        });
      }
    }

    if (balance !== afateve.tokenBalance) {
      throw new Error(`Seed ledger for Alfateve ends at ${balance}, expected ${afateve.tokenBalance}.`);
    }

    const lumiere = DEMO_WORKSPACES[4]!;
    await tx.insert(tokenLedger).values({
      workspaceId: lumiere.id,
      userId: superadmin.id,
      txType: "TOPUP",
      amount: lumiere.tokenBalance,
      balanceAfter: lumiere.tokenBalance,
      notes: `plan:+${lumiere.freePlanRemaining}`,
      createdAt: new Date("2026-11-01T10:10:00.000Z"),
    });
  }
}

interface SeedOptions {
  demo: boolean;
}

export async function runSeed(options: SeedOptions): Promise<string[]> {
  await db.transaction(async (tx) => {
    await seedPlatform(tx);
    if (options.demo) await seedDemo(tx);
  });

  const lines = [`${env.SEED_SUPERADMIN_EMAIL.toLowerCase()}: ${env.SEED_SUPERADMIN_PASSWORD}`];
  if (options.demo) {
    for (const account of DEMO_ACCOUNTS) {
      lines.push(`${account.email}: ${env.DEMO_SEED_PASSWORD}`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const noDemo = args.includes("--no-demo");

  if (env.NODE_ENV === "production" && !force) {
    console.error(
      "Refusing to seed a production database without --force. Run with --force to seed platform data.",
    );
    process.exitCode = 1;
    return;
  }

  const demo = env.NODE_ENV !== "production" && !noDemo;
  const lines = await runSeed({ demo });

  for (const line of lines) console.log(line);
  if (!demo) console.log("(demo dataset skipped)");
}

const isCli = process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js");

if (isCli) {
  main()
    .then(async () => {
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await closeDb();
      process.exit(1);
    });
}
