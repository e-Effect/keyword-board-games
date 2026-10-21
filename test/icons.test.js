const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const publicDir = path.join(__dirname, "../public");

test("app icons are opaque PNGs in their declared sizes, with separate maskable artwork", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "site.webmanifest"), "utf8"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.icons.filter((icon) => icon.purpose === "maskable").length, 1);
  for (const icon of [...manifest.icons, { src: "/assets/ghost-game-180.png", sizes: "180x180" }, { src: "/assets/ghost-game-32.png", sizes: "32x32" }]) {
    const bytes = fs.readFileSync(path.join(publicDir, icon.src));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
    assert.equal(bytes[25], 2, "icon must be opaque RGB");
  }
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  assert.ok(html.includes('rel="apple-touch-icon" href="/assets/ghost-game-180.png"'));
  assert.ok(html.includes('class="brand-mark" src="/assets/ghost-game-192.png"'));
  const sw = fs.readFileSync(path.join(publicDir, "sw.js"), "utf8");
  for (const icon of manifest.icons) assert.ok(sw.includes(`"${icon.src}"`));
});
