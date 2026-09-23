import assert from "node:assert/strict";
import { test } from "node:test";
import { readThemePreferences, resolveTheme } from "../src/themePreferences.ts";

test("legacy appearance modes retain their original appearance after migration", () => {
  for (const mode of ["light", "dark", "system"]) {
    const preferences = readThemePreferences(mode);
    assert.equal(preferences.mode, mode);
    assert.equal(preferences.light, "default_light");
    assert.equal(preferences.dark, "default_dark");
  }
});

test("saved palettes retain fixed appearance even under the opposite system appearance", () => {
  for (const [palette, appearance, opposite] of [
    ["mint_light_blue", "light", "dark"],
    ["mint_light_green", "light", "dark"],
    ["mint_dark_blue", "dark", "light"],
    ["mint_dark_green", "dark", "light"],
  ]) {
    const preferences = readThemePreferences(
      JSON.stringify({
        mode: appearance,
        [appearance]: palette,
      }),
    );
    assert.deepEqual(resolveTheme(preferences, opposite), {
      appearance,
      palette,
    });
    assert.equal(preferences[opposite], `default_${opposite}`);
    assert.deepEqual(
      readThemePreferences(JSON.stringify(preferences)),
      preferences,
    );
  }
});

test("system mode resolves independently chosen palettes after a storage round trip", () => {
  const preferences = readThemePreferences(
    JSON.stringify({
      mode: "system",
      light: "mint_light_blue",
      dark: "mint_dark_green",
    }),
  );
  assert.deepEqual(resolveTheme(preferences, "light"), {
    appearance: "light",
    palette: "mint_light_blue",
  });
  assert.deepEqual(resolveTheme(preferences, "dark"), {
    appearance: "dark",
    palette: "mint_dark_green",
  });
  assert.deepEqual(
    readThemePreferences(JSON.stringify(preferences)),
    preferences,
  );
});

test("editing the inactive palette leaves fixed mode unchanged and takes effect when mode changes", () => {
  const preferences = readThemePreferences(
    JSON.stringify({
      mode: "light",
      light: "mint_light_green",
      dark: "mint_dark_blue",
    }),
  );
  const changed = { ...preferences, dark: "mint_dark_green" };
  assert.deepEqual(
    resolveTheme(changed, "dark"),
    resolveTheme(preferences, "dark"),
  );
  assert.deepEqual(resolveTheme({ ...changed, mode: "dark" }, "light"), {
    appearance: "dark",
    palette: "mint_dark_green",
  });
});

test("invalid storage and cross-appearance palettes fall back without losing valid preferences", () => {
  const defaults = {
    mode: "system",
    light: "default_light",
    dark: "default_dark",
  };
  for (const stored of [
    null,
    "",
    "unknown-theme",
    "{broken",
    "null",
    "[]",
    "true",
  ]) {
    assert.deepEqual(readThemePreferences(stored), defaults);
  }
  assert.deepEqual(
    readThemePreferences(
      JSON.stringify({
        mode: "unknown",
        light: "mint_dark_green",
        dark: "mint_light_blue",
      }),
    ),
    defaults,
  );
  assert.deepEqual(
    readThemePreferences(
      JSON.stringify({
        mode: "dark",
        light: "removed-palette",
        dark: "mint_dark_green",
      }),
    ),
    { ...defaults, mode: "dark", dark: "mint_dark_green" },
  );
});
