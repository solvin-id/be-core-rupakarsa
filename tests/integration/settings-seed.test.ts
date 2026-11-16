import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../src/db/client.js";
import { seedPlatform } from "../../src/db/seed.js";
import { appSettings } from "../../src/db/schema.js";
import { SETTING_KEYS, getContact, writeSetting } from "../../src/services/settings.js";
import { resetDatabase } from "./helpers.js";

describe("settings seeding", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("keeps an operator-saved contact when the platform seed runs again", async () => {
    await db.transaction(async (tx) => {
      await writeSetting(tx, SETTING_KEYS.contact, {
        name: "Tim Operator",
        whatsapp: "6281234567890",
        email: "halo@rupakarsa.id",
      });
    });

    await db.transaction(async (tx) => {
      await seedPlatform(tx);
    });

    expect(await getContact(db)).toEqual({
      name: "Tim Operator",
      whatsapp: "6281234567890",
      email: "halo@rupakarsa.id",
    });

    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTING_KEYS.contact));
    expect(rows).toHaveLength(1);
  });
});
