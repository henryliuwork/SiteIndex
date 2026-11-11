/** @typedef {{ date: string, firstSeen: string, parentGroups: number, childrenPerGroup: number, ungroupedSkus: number, totalSkus: number, products: number, blogsBeforeRefresh: number, blogsAfterRefresh: number, issues: number, pages: number, links: number, inStock: number, outOfStock: number, category: string, trendParentSku: string, trendHistory30d: string, trendOnlineRate7d: number, trendOnlineRate30d: number, trendLastChangeAt: string }} W2SyntheticFixtureSummary */

export const W2_SYNTHETIC_EXPECTED = Object.freeze({
  date: "2026-11-10",
  firstSeen: "2026-10-12",
  parentGroups: 40,
  childrenPerGroup: 3,
  ungroupedSkus: 40,
  totalSkus: 160,
  products: 80,
  blogsBeforeRefresh: 65,
  blogsAfterRefresh: 2,
  issues: 66,
  pages: 145,
  links: 144,
  intentionalOrphanPath: "/products/group-000",
  inStock: 101,
  outOfStock: 59,
  category: "synthetic-category",
  trendParentSku: "SYN-P001",
  trendHistory30d: `${"o".repeat(15)}${"i".repeat(15)}`,
  trendOnlineRate7d: 1,
  trendOnlineRate30d: 0.5,
  trendLastChangeAt: "2026-10-27",
});

function dateAtOffset(date, offset) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function statusFromSymbol(symbol) {
  if (symbol === "i") return "in_stock";
  if (symbol === "o") return "out_of_stock";
  if (symbol === "p") return "preorder";
  return "unknown";
}

function symbolFromStatus(status) {
  if (status === "in_stock") return "i";
  if (status === "out_of_stock") return "o";
  if (status === "preorder") return "p";
  return "u";
}

function statusHistory(group, variant, status) {
  if (group === 1 && variant === 2) return `${"o".repeat(15)}${"i".repeat(15)}`;
  if (group === 1 && variant === 3) return `${"o".repeat(20)}${"i".repeat(10)}`;
  return symbolFromStatus(status).repeat(30);
}

function stockMetadata(history, date) {
  const currentSymbol = history.at(-1);
  let daysInStatus = 1;
  while (daysInStatus < history.length && history.at(-daysInStatus - 1) === currentSymbol) daysInStatus += 1;
  const transitions = [];
  for (let index = 1; index < history.length; index += 1) {
    if (history[index - 1] !== "-" && history[index] !== "-" && history[index - 1] !== history[index]) {
      transitions.push({ date: dateAtOffset(date, index - 29), from: history[index - 1], to: history[index] });
    }
  }
  const rate = (days) => {
    const window = [...history.slice(-days)].filter((symbol) => symbol !== "-");
    return window.length ? window.filter((symbol) => symbol === "i").length / window.length : null;
  };
  const lastTransition = transitions.at(-1) ?? null;
  return {
    stock_status: statusFromSymbol(currentSymbol),
    since: dateAtOffset(date, -(daysInStatus - 1)),
    days_in_status: daysInStatus,
    online_rate_7d: rate(7),
    online_rate_30d: rate(30),
    history_30d: history,
    changes_30d: transitions.length,
    last_change: lastTransition ? "stock_change" : null,
    last_change_at: lastTransition?.date ?? null,
    transitions,
  };
}

function syntheticSeoPage(url, date, options = {}) {
  const title = Object.hasOwn(options, "title") ? options.title : "Synthetic SEO page";
  const description = Object.hasOwn(options, "description") ? options.description : "Synthetic acceptance page description.";
  const pageType = options.pageType ?? "product";
  const schemaTypes = options.schemaTypes ?? ["Product"];
  return {
    url,
    page_type: pageType,
    status_code: 200,
    final_url: null,
    response_ms: 1,
    title,
    title_length: title?.length ?? 0,
    meta_description: description,
    description_length: description?.length ?? 0,
    h1: "Synthetic heading",
    h1_count: 1,
    h2: [],
    canonical: url,
    canonical_status: "self",
    robots_meta: null,
    x_robots_tag: null,
    indexable: true,
    in_sitemap: true,
    google_indexed: null,
    schema_types: schemaTypes,
    word_count: 10,
    images_total: 0,
    images_missing_alt: 0,
    links_internal_out: 0,
    links_external_out: 0,
    links_internal_in: 0,
    last_crawled: date,
  };
}

/**
 * Build a deterministic, in-memory fixture for the packaged E W2 page checks.
 *
 * @param {string} origin
 * @returns {{ config: object, skus: object[], latest: object[], skuStock: object[], products: object[], seoPages: object[], seoIssues: object[], seoLinks: object[], blogs: object[], productDetails: object[], outreach: object[], categories: object[], dailySummaryRows: object[], events: object[], summary: W2SyntheticFixtureSummary }}
 */
export function makeW2SyntheticFixture(origin) {
  const expected = W2_SYNTHETIC_EXPECTED;
  const { date, firstSeen, category } = expected;
  const config = {
    schema_version: "1.1", domain: "w2.example.invalid", base_url: origin, platform: "woocommerce", currency: "USD",
    locale: "en-US", timezone: "UTC", markets: ["US"],
    brand: { name: "Synthetic W2 project", tagline: "Hosted runner acceptance data" },
    sitemaps: [`${origin}/sitemap.xml`],
    content: { blog_sitemaps: [`${origin}/blog-sitemap.xml`], blog_url_patterns: ["/blog/"] },
    crawl: { adapter: "gmc_feed", feed_url: [], sku_field: "id", missing_as: "out_of_stock", max_pages: 200, rate_limit_ms: 200, blog_url_patterns: [] },
    categories: { mode: "feed" }, sku_grouping: { enabled: true, rule: { type: "separator", value: "-CH-" } }, workspace_folders: [],
    schedule: {
      daily: { enabled: false, days: [], time: "00:00" },
      validate: { enabled: false, days: [], time: "00:00" },
      weekly: { enabled: false, days: [], time: "00:00" },
      readme: { enabled: false, days: [], time: "00:00" },
      monthly: { enabled: false, days: [], time: "00:00", day_of_month: 1 },
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false },
    },
  };
  const skus = [], latest = [], skuStock = [], products = [], events = [];
  const stockState = (group, variant) => group === 0 || variant !== 1 ? "in_stock" : "out_of_stock";
  const addSku = (sku, handle, title, variant, status, parent, price, history) => {
    const metadata = stockMetadata(history, date);
    const variantTitle = variant ? `Synthetic option ${variant}` : null;
    skus.push({ sku, product_id: `product-${handle}`, handle, title, variant_title: variantTitle,
      url: `${origin}/products/${handle}${variant ? `?variant=${variant}` : ""}`, category,
      categories: [category], category_source: "feed", price, compare_at_price: null, currency: "USD",
      image_url: null, status: "active", first_seen: firstSeen, last_seen: date, updated_at: date });
    latest.push({ sku, stock_status: metadata.stock_status, qty: metadata.stock_status === "in_stock" ? 10 : 0,
      since: metadata.since, checked_at: `${date}T12:00:00.000Z` });
    skuStock.push({ sku, title, variant_title: variantTitle, category, price, stock_status: metadata.stock_status,
      since: metadata.since, days_in_status: metadata.days_in_status, online_rate_7d: metadata.online_rate_7d,
      online_rate_30d: metadata.online_rate_30d, history_30d: metadata.history_30d,
      changes_30d: metadata.changes_30d, last_change: metadata.last_change, last_change_at: metadata.last_change_at,
      parent_sku: parent, price_history: [] });
    for (const transition of metadata.transitions) {
      events.push({ date: transition.date, sku, type: "stock_change", from: statusFromSymbol(transition.from),
        to: statusFromSymbol(transition.to), category, title });
    }
    return { sku, price, status: metadata.stock_status };
  };
  const addProduct = (handle, title, rows) => {
    const prices = rows.map((row) => row.price);
    const inStock = rows.filter((row) => row.status === "in_stock").length;
    products.push({ handle, product_id: `product-${handle}`, title, url: `${origin}/products/${handle}`,
      category, categories: [category], price_min: Math.min(...prices), price_max: Math.max(...prices), compare_at_max: null,
      currency: "USD", on_sale: false, image_url: null, image_source: "none", feed_image_url: null, manual_image_url: null,
      variant_count: rows.length, skus: rows.map((row) => row.sku), in_stock_variants: inStock,
      stock_status: inStock ? "in_stock" : "out_of_stock", stock_since: date, row_kind: "single", parent_sku: null,
      tags: [], priority: null, exclude_edm: 0, last_featured: null, days_since_featured: null,
      first_seen: firstSeen, status: "active" });
  };

  for (let group = 0; group < expected.parentGroups; group += 1) {
    const parent = `SYN-P${String(group).padStart(3, "0")}`;
    const handle = `group-${String(group).padStart(3, "0")}`;
    const children = [];
    for (let variant = 1; variant <= expected.childrenPerGroup; variant += 1) {
      const title = `Synthetic grouped product ${String(group).padStart(3, "0")}`;
      const status = stockState(group, variant);
      children.push(addSku(`${parent}-CH-${String(variant).padStart(2, "0")}`, handle, title, variant,
        status, parent, 10 + group + variant / 100, statusHistory(group, variant, status)));
    }
    addProduct(handle, `Synthetic grouped product ${String(group).padStart(3, "0")}`, children);
  }

  for (let single = 0; single < expected.ungroupedSkus; single += 1) {
    const sku = `SYN-SINGLE-${String(single).padStart(3, "0")}`;
    const handle = `single-${String(single).padStart(3, "0")}`;
    const status = single % 2 === 0 ? "in_stock" : "out_of_stock";
    const title = `Synthetic single product ${String(single).padStart(3, "0")}`;
    addProduct(handle, title, [addSku(sku, handle, title, null, status, null, 20 + single, statusHistory(-1, 0, status))]);
  }

  const productPages = products.map((product, index) => {
    const hasIssue = index < expected.issues;
    const missingTitle = hasIssue && index < expected.issues - 6;
    const missingDescription = hasIssue && !missingTitle;
    return syntheticSeoPage(product.url, date, {
      title: missingTitle ? null : `Synthetic ${product.title}`,
      description: missingDescription ? null : "Synthetic description is present.",
      pageType: "product",
      schemaTypes: ["Product"],
    });
  });
  const issuePages = productPages.slice(0, expected.issues);
  const blogs = Array.from({ length: expected.blogsBeforeRefresh }, (_, index) => {
    const slug = `synthetic-article-${String(index).padStart(3, "0")}`;
    return { url: `${origin}/blog/article-${String(index).padStart(3, "0")}`, slug,
      title: `Synthetic blog article ${String(index).padStart(3, "0")}`, published_at: date, updated_at: null,
      category, author: "Synthetic author", tags: [], meta_description: "Synthetic blog content for packaged acceptance.",
      word_count: 10, reading_minutes: 1, outline: [], has_faq: true, featured_image: null, primary_keyword: null,
      links_internal: [], links_products: [], links_in: 0, linked_out_of_stock: [], last_crawled: date };
  });
  const blogPages = blogs.map((blog) => syntheticSeoPage(blog.url, date, {
    title: blog.title, description: blog.meta_description, pageType: "blog", schemaTypes: ["BlogPosting"],
  }));
  const seoPages = [...productPages, ...blogPages];
  const seoLinks = [];
  const incoming = new Map(seoPages.map((page) => [page.url, 0]));
  const outgoing = new Map(seoPages.map((page) => [page.url, 0]));
  for (let index = 0; index < seoPages.length - 1; index += 1) {
    const source = seoPages[index];
    const target = seoPages[index + 1];
    seoLinks.push({ from: source.url, to: target.url, anchor: `Synthetic internal edge ${String(index).padStart(3, "0")}`,
      to_type: target.page_type });
    outgoing.set(source.url, (outgoing.get(source.url) ?? 0) + 1);
    incoming.set(target.url, (incoming.get(target.url) ?? 0) + 1);
  }
  for (const page of seoPages) {
    page.links_internal_out = outgoing.get(page.url) ?? 0;
    page.links_internal_in = incoming.get(page.url) ?? 0;
  }
  for (const blog of blogs) blog.links_in = incoming.get(blog.url) ?? 0;

  const seoIssues = Array.from({ length: expected.issues }, (_, index) => ({
    url: issuePages[index].url,
    rule: index < expected.issues - 6 ? "title_missing" : "desc_missing",
    severity: index < expected.issues - 6 ? "high" : "mid",
    detail: index < expected.issues - 6 ? "Synthetic page title is missing" : "Synthetic meta description is missing",
    status: "open", first_seen: date, last_seen: date,
  }));
  const productDetails = products.map((product) => ({ handle: product.handle, short_description: null,
    rating: null, review_count: null, breadcrumbs: [], gallery: [], related_handles: [], badges: [],
    shipping_note: null, last_crawled: date }));
  const outreach = [{ domain: "synthetic-partner.example", added_at: date, status: "contacted",
    linkflow_id: null, topic: "synthetic", note: "Synthetic W2 fixture" }];
  const inStock = latest.filter((row) => row.stock_status === "in_stock").length;
  const outOfStock = latest.filter((row) => row.stock_status === "out_of_stock").length;
  const dailySummaryRows = [
    { date, category: "_all", total: latest.length, in_stock: inStock, out_of_stock: outOfStock, preorder: 0, unknown: 0 },
    { date, category, total: latest.length, in_stock: inStock, out_of_stock: outOfStock, preorder: 0, unknown: 0 },
  ];
  const categories = [{ slug: category, name: "Synthetic category", url: "", parent: null, source: "feed",
    product_count: products.length, sku_count: latest.length, in_stock_count: inStock, intro_text_words: null, last_seen: date }];
  const sortedEvents = events.sort((left, right) => left.date.localeCompare(right.date) || left.sku.localeCompare(right.sku));
  const summary = /** @type {W2SyntheticFixtureSummary} */ ({
    date, firstSeen, parentGroups: expected.parentGroups, childrenPerGroup: expected.childrenPerGroup,
    ungroupedSkus: expected.ungroupedSkus, totalSkus: latest.length, products: products.length,
    blogsBeforeRefresh: blogs.length, blogsAfterRefresh: expected.blogsAfterRefresh, issues: seoIssues.length,
    pages: seoPages.length, links: seoLinks.length, inStock, outOfStock, category,
    trendParentSku: expected.trendParentSku, trendHistory30d: expected.trendHistory30d,
    trendOnlineRate7d: expected.trendOnlineRate7d, trendOnlineRate30d: expected.trendOnlineRate30d,
    trendLastChangeAt: expected.trendLastChangeAt,
  });

  return { config, skus, latest, skuStock, products, seoPages, seoIssues, seoLinks, blogs, productDetails,
    outreach, categories, dailySummaryRows, events: sortedEvents, summary };
}
