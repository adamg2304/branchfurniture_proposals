/* =====================================================================
   window.QUOTE — DEV-ONLY sample payload.
   Lets the template render standalone in the viewer with instant refresh,
   no HubSpot round-trip. In production the api-server injects an object of
   this exact shape built from live HubSpot data.

   imageUrl values are the REAL hub_image values from HubSpot (Shopify CDN).
   disc = per-unit discount ($); net unit = price - disc; net line = net unit x qty.
   White Glove is a line item (sku "White Glove Delivery"); the template pulls
   it out of the product rows and shows it as the summary line.
   ===================================================================== */
window.QUOTE = {
  accepted: false,
  currency: "USD",

  customer: {
    company: "Chai Travel",
    location: "Brooklyn, NY",
    contactName: "Daniella Pally",
    contactTitle: "Chief Brand Officer",
    contactEmail: "daniella@chaitravel.com"
  },

  project: {
    name: "Chai Travel HQ Fit-Out",
    address: "307 7th Avenue, Suite 1107",
    city: "Brooklyn",
    state: "NY",
    zip: "11215",
    country: "United States"
  },

  rep: {
    name: "Bailey Shorr",
    title: "Account Executive",
    email: "bailey@branchfurniture.com",
    phone: "+1 (781) 654-1967"
  },

  meta: {
    ref: "20260714-202928212",
    dealId: "SAMPLE-DEAL",
    token: "SAMPLETOKEN",
    status: "Sent",
    created: "2026-08-11",
    expires: "2026-08-18",   // 7-day validity window
    itemsUpdated: "2026-08-11T00:00:00Z",
    deliveryMethod: "White Glove Delivery & Installation",
    nextStep: "Review quote and confirm quantities",
    acceptUrl: "/api/q/41421676299/accept",
    floorplanUrl: "/floorplan-sample.svg"   // dev placeholder; live quotes resolve the deal's floorplan file
  },

  rates: {
    wgAmount:  2484.95,
    wgRate:    0.163127,
    discount:  1218.64,
    taxAmount: 1464.31,
    taxRate:   0.086401,
    taxLabel:  "Tax (Brooklyn, NY)"
  },

  items: [
    { name: "Conference Table for 10-12", spec: "Walnut Top / Charcoal Leg", size: '142" × 48"', sku: "12-01-15-32", price: 2249.00, disc: 179.92, qty: 1,  orig: 1,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/conferencetable-pdp-142-render-walnut-charcoal-2.webp?v=1738621456", productUrl: "https://www.branchfurniture.com/products/conference-table" },
    { name: "Meeting Table",               spec: "Walnut / Charcoal",         size: "",           sku: "12-02-48-02", price: 1149.00, disc: 91.92,  qty: 1,  orig: 1,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/20231110_Branch_MeetingTable_Charcoal_Walnut.jpg?v=1734731154", productUrl: "https://www.branchfurniture.com/products/meeting-table" },
    { name: "Office Desk",                  spec: "Walnut Top / Charcoal Leg", size: '48" × 24"',  sku: "10-00-53-32", price: 499.00,  disc: 39.92,  qty: 4,  orig: 4,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/20240326_OfficeDesk_ThreeQuartersfront_WalnutCharcoal_48in.jpg?v=1734731956", productUrl: "https://www.branchfurniture.com/products/office-desk" },
    { name: "Office Desk",                  spec: "Walnut Top / Charcoal Leg", size: '60" × 30"',  sku: "10-00-67-32", price: 679.00,  disc: 54.32,  qty: 1,  orig: 1,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/20220510_OfficeDesk_WalnutTop-CharcoalLegscopy.jpg?v=1734731956", productUrl: "https://www.branchfurniture.com/products/office-desk" },
    { name: "Ergonomic Chair",             spec: "Pebble / White / Standard", size: "",           sku: "11-01-00-53", price: 389.00,  disc: 31.12,  qty: 9,  orig: 9,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/pebble-front-hi_97a0b88c-db5e-4703-9dde-8c6632124ff3.jpg?v=1740774897", productUrl: "https://www.branchfurniture.com/products/ergonomic-chair" },
    { name: "Daily Chair",                  spec: "Black / Black / Standard",  size: "",           sku: "11-03-00-50", price: 259.00,  disc: 20.72,  qty: 16, orig: 16, imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/black_20210910_DailyChair_FrontPerspective_1_1.jpg?v=1758663428", productUrl: "https://www.branchfurniture.com/products/daily-chair" },
    { name: "Small Filing Cabinet",        spec: "Charcoal / Standard",       size: "",           sku: "14-06-00-69", price: 239.00,  disc: 19.12,  qty: 5,  orig: 5,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/charcoal-SMF1.jpg?v=1734735224", productUrl: "https://www.branchfurniture.com/products/filing-cabinet" },
    { name: "In-Desk Power",                spec: "Standard",                 size: "",           sku: "13-11-00-00", price: 160.00,  disc: 12.80,  qty: 2,  orig: 2,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/20240307_Branch_ModularSofa_Front_Config01.webp?v=1746116979", productUrl: "https://www.branchfurniture.com/products/in-desk-power" },
    { name: "White Glove Delivery",        spec: "Scheduled delivery, full assembly, in-room placement, and packaging removal.", size: "", sku: "White Glove Delivery", price: 2484.95, disc: 0, qty: 1, orig: 1, imageUrl: "", productUrl: "" }
  ]
};
