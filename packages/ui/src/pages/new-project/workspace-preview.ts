import type { Platform, WorkspaceCreateInput } from "@siteindex/shared";

export const workspaceDirectoryTree = (folderName: string): string => `${folderName}/
├── README.md
├── AGENTS.md
├── CLAUDE.md
├── .env
├── .gitignore
├── workspace.json
├── 01-brand/
│   ├── README.md
│   ├── assets/
│   └── sops/
├── 02-products/
│   ├── README.md
│   ├── listings/
│   ├── media/
│   └── stock/
├── 03-seo/  (audit, blog, guest, refresh, topic-pages)
├── 04-edm/  (emails, planner, strategy, templates)
├── 05-affiliate/  (kit, newsletter, partners)
├── 06-site-updates/  (banners, campaigns, pages)
├── 07-reports/
├── _outputs/  _archive/  _tmp/
└── _site-index/
    ├── site.json
    ├── workspace.json
    ├── skills/
    │   ├── manifest.json
    │   └── presets/esp.mailchimp.md
    └── archive/ catalog/ content/ design/ edm/ inventory/
        ledgers/ reports/ seo/ site/ views/`;

export function workspacePathJoin(root: string, folder: string): string {
  const cleanRoot = root.trim().replace(/[\\/]+$/, "");
  if (!cleanRoot) return folder.trim();
  return cleanRoot + (root.includes("\\") ? "\\" : "/") + folder.trim();
}

export function workspacePlatformFromDetected(platform: Platform): WorkspaceCreateInput["platform"] {
  if (platform === "magento") return "magento2";
  if (platform === "woocommerce" || platform === "shopify") return platform;
  return "other";
}
