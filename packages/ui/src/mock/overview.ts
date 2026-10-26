import type { OverviewData, SiteIndexApi } from "@siteindex/shared";
import { FIXED_TODAY, dateBefore, projectKey, projectSummaries, reply } from "./context";

export function createOverviewMock(): SiteIndexApi["overview"] {
  return {
    get: (id) => reply<OverviewData>(() => {
      const key = projectKey(id);
      const summary = projectSummaries[key];
      const groupName = key === "kingsyard" ? "bird-feeders" : "camping-chairs";
      const kpis: OverviewData["kpis"] = [
        { key: "sku-products", label: "SKU / 产品", value: summary.sku_count.toLocaleString("zh-CN") + " / " + summary.product_count.toLocaleString("zh-CN"), link: "/p/" + id + "/inventory" },
        { key: "online-rate", label: "有货率", value: ((summary.online_rate ?? 0) * 100).toFixed(1) + "%", hint: "今日 +1 到货，−2 缺货", link: "/p/" + id + "/inventory" },
        { key: "seo-issues", label: "SEO 问题", value: "7", hint: "高 1 · 中 3 · 低 3", tone: "danger", link: "/p/" + id + "/seo" },
        { key: "blog-keywords", label: "博客 / 关键词", value: "2 / 2", hint: "2 个核心词未覆盖", link: "/p/" + id + "/content" },
        { key: "edm-images", label: "EDM 首图", value: "18 / 19", hint: "抓取 17 · 手动补 1 · 缺图 1", link: "/p/" + id + "/edm" },
        { key: "sales", label: "30 天销量", value: "—", hint: "预留 · 待接入", reserved: true },
      ];
      const attention: OverviewData["attention"] = [
        { severity: "high", text: "数据校验：seo/links.jsonl、ledgers/sku_tags.csv 出错，views/products.jsonl 缺失", link: "/p/" + id + "/settings/files", link_label: "修复" },
        { severity: "high", text: "sitemap 中有 1 个 404 页面：/blog/missing-post", link: "/p/" + id + "/seo", link_label: "查看" },
        { severity: "mid", text: groupName + " 新增 2 个缺货 SKU，有货率降至 73%", link: "/p/" + id + "/inventory", link_label: "查看" },
        { severity: "mid", text: "1 个 SKU 库存状态无法识别（feed 值为 \"limited\"）", link: "/p/" + id + "/inventory", link_label: "查看" },
        { severity: "low", text: "1 个 SKU 没有首图（feed 未抓取到，也未手动填写），不会进入 EDM", link: "/p/" + id + "/edm", link_label: "补图" },
        { severity: "low", text: "文件夹 设计/ 缺少 _about.md 说明", link: "/p/" + id + "/settings/folders", link_label: "查看" },
      ];
      return {
        kpis,
        attention,
        readme: { overview: "Wild bird feeding supplies for backyard birders. 目标市场 US；目标人群 Backyard bird lovers and gift buyers；文案调性 Warm, practical, nature-loving; short sentences.", focus: "10 月：Halloween / 秋季喂鸟季 EDM；补齐吸鸟指南类博客" },
        agent_instruction: "进入 " + summary.path + "，先完整阅读 README.md，再根据数据开展工作。",
        changelog: [
          { date: FIXED_TODAY, text: "数据校验：2 个文件错误、1 个缺失" },
          { date: dateBefore(2), text: "每日同步：+1 到货、−2 缺货、上新 Window Feeder" },
          { date: dateBefore(2), text: "Skill 更新：edm-builder 1.2.0" },
          { date: dateBefore(3), text: "新建项目，首次同步 18 个 SKU" },
        ],
      };
    }),
  };
}
