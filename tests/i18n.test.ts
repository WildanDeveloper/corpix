import { describe, expect, it } from "vitest";
import { DICTIONARIES, LOCALES, translate } from "../apps/web/src/i18n-dict";

describe("UI i18n", () => {
  it("translates the main navigation", () => {
    expect(translate("id", "Settings")).toBe("Pengaturan");
    expect(translate("id", "Office")).toBe("Kantor");
    expect(translate("id", "Minds")).toBe("Pikiran");
  });

  it("keeps English as the identity", () => {
    expect(translate("en", "Settings")).toBe("Settings");
  });

  it("falls back to the English sentence when a key is missing", () => {
    expect(translate("id", "This sentence was never translated")).toBe(
      "This sentence was never translated",
    );
  });

  it("interpolates named variables", () => {
    expect(translate("id", "Say something to {name}…", { name: "Rizky" })).toBe(
      "Bicara ke Rizky…",
    );
    expect(translate("en", "Say something to {name}…", { name: "Rizky" })).toBe(
      "Say something to Rizky…",
    );
  });

  it("has no empty translations", () => {
    for (const locale of LOCALES) {
      const entries = Object.entries(DICTIONARIES[locale]) as Array<[string, string]>;
      for (const [key, value] of entries) {
        expect(key.trim().length, `empty key in ${locale}`).toBeGreaterThan(0);
        expect(value.trim().length, `empty value for "${key}" in ${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it("translates every placeholder the components rely on", () => {
    const required = [
      "Dispatch",
      "Cancel",
      "Approve",
      "Deny",
      "Resume",
      "Register",
      "Test connection",
      "Save",
      "Saving…",
      "Company name",
      "Integration branch",
      "Approval mode",
      "Sandbox",
      "Own session",
      "Remembers",
    ];
    for (const text of required) {
      expect(translate("id", text), text).not.toBe(text);
    }
  });
});
