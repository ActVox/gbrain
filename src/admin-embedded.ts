// AUTO-GENERATED — do not edit by hand.
// Run `bun run scripts/build-admin-embedded.ts` to regenerate.
// Source: admin/dist/ at 2026-10-01.
//
// Bun resolves the file: imports to a path that works at runtime even
// inside a compiled binary (`bun build --compile`). The manifest maps
// the request path the express handler sees to (resolved-path, mime).

// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_0_assets_index_C1D4HToW_css from '../admin/dist/assets/index-C1D4HToW.css' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_1_assets_index_DQpLv_A4_js from '../admin/dist/assets/index-DQpLv-A4.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_2_brand_JetBrainsMono_OFL_txt from '../admin/dist/brand/JetBrainsMono-OFL.txt' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_3_brand_README_txt from '../admin/dist/brand/README.txt' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_4_brand_apple_touch_icon_png from '../admin/dist/brand/apple-touch-icon.png' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_5_brand_favicon_ico from '../admin/dist/brand/favicon.ico' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_6_brand_font_5_ttf from '../admin/dist/brand/font-5.ttf' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_7_brand_font_6_ttf from '../admin/dist/brand/font-6.ttf' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_8_brand_logo_black_png from '../admin/dist/brand/logo-black.png' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_9_brand_logo_white_png from '../admin/dist/brand/logo-white.png' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_10_index_html from '../admin/dist/index.html' with { type: 'file' };

export interface AdminAsset {
  path: string;
  mime: string;
}

export const ADMIN_ASSETS: Record<string, AdminAsset> = {
  "/admin/assets/index-C1D4HToW.css": { path: A_0_assets_index_C1D4HToW_css as unknown as string, mime: "text/css; charset=utf-8" },
  "/admin/assets/index-DQpLv-A4.js": { path: A_1_assets_index_DQpLv_A4_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/brand/JetBrainsMono-OFL.txt": { path: A_2_brand_JetBrainsMono_OFL_txt as unknown as string, mime: "text/plain; charset=utf-8" },
  "/admin/brand/README.txt": { path: A_3_brand_README_txt as unknown as string, mime: "text/plain; charset=utf-8" },
  "/admin/brand/apple-touch-icon.png": { path: A_4_brand_apple_touch_icon_png as unknown as string, mime: "image/png" },
  "/admin/brand/favicon.ico": { path: A_5_brand_favicon_ico as unknown as string, mime: "image/x-icon" },
  "/admin/brand/font-5.ttf": { path: A_6_brand_font_5_ttf as unknown as string, mime: "application/octet-stream" },
  "/admin/brand/font-6.ttf": { path: A_7_brand_font_6_ttf as unknown as string, mime: "application/octet-stream" },
  "/admin/brand/logo-black.png": { path: A_8_brand_logo_black_png as unknown as string, mime: "image/png" },
  "/admin/brand/logo-white.png": { path: A_9_brand_logo_white_png as unknown as string, mime: "image/png" },
  "/admin/index.html": { path: A_10_index_html as unknown as string, mime: "text/html; charset=utf-8" },
};

/** Index entry point for SPA fallback. */
export const ADMIN_INDEX_HTML: AdminAsset = ADMIN_ASSETS['/admin/index.html'];

export const ADMIN_ASSET_COUNT = 11;
