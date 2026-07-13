/* Demo dataset — realistic rows for ?demo=1 preview mode (and UI verification).
   Shapes mirror the Supabase `cards` table exactly. No writes occur in demo mode. */

const mk = (o) => ({
  id: Math.floor(Math.random() * 1e9), user_id: "demo", natural_key: "demo" + Math.random().toString(16).slice(2, 10),
  bucket: "pkmn", name: "", set_name: "", number: "", variance: "Holofoil", grade: "", rarity: "",
  qty: 1, price: 0, market_price: 0, condition: "NM", channel: "TCGplayer",
  channel_reason: "net-best fixed price", flags: [], band: "5_50", value_tier: "MID",
  card_class: "modern_smooth", psa10: 0, psa10_real: false, psa10_x: 0,
  shop_trade: 0, shop_cash: 0, net_unit: 0, net_pct: 0.8, grade_flag: false,
  grade_gap: 0, grade_reason: "", keep: false, tags: [], photos: [], image_url: null, ...o,
});
const fin = (r) => {
  r.market_price = r.market_price || r.price;
  if (!["pkmn", "mtg", "ygo"].includes(r.bucket)) {   // holds: no routing, no nets
    r.net_unit = 0; r.net_pct = 0; r.shop_trade = 0; r.shop_cash = 0;
    return r;
  }
  r.shop_trade = Math.round(r.price * (r.price > 10 ? 0.8 : 0.7) * 100) / 100;
  r.shop_cash = Math.round(r.price * (r.price > 10 ? 0.7 : 0.6) * 100) / 100;
  if (!r.net_unit) r.net_unit = Math.round(r.price * 0.86 * 100) / 100;
  r.net_pct = r.price ? Math.round((r.net_unit / r.price) * 1000) / 1000 : 0;
  return r;
};

export const DEMO_ROWS = [
  // ── Pokémon raw, undecided ──
  { rarity: "Special Illustration Rare", name: "Giratina V (Alternate Full Art)", set_name: "Lost Origin", number: "186/196", price: 867.95,
    channel: "eBay (auction)", channel_reason: "scarce/chase — auction realizes above market",
    flags: ["ebay-authenticity-$250+", "tcgp-tracking-$50+", "scarce"], band: "o50", value_tier: "HIGH",
    card_class: "modern_textured", psa10: 2603.85, psa10_x: 3.0, grade_flag: true, grade_gap: 142,
    grade_reason: "modern_textured: graded EV $880 vs raw $738 (+$142) via Express — verify centering first",
    net_unit: 748.05, image_url: "https://images.pokemontcg.io/swsh11/186.png" },
  { rarity: "Holo Rare", name: "Dragonite", set_name: "Expedition", number: "9", price: 799.69,
    channel: "eBay (auction)", channel_reason: "scarce/chase — auction realizes above market",
    flags: ["ebay-authenticity-$250+", "tcgp-tracking-$50+", "scarce"], band: "o50", value_tier: "HIGH",
    card_class: "vintage", psa10: 6397.52, psa10_real: true, psa10_x: 8.0, grade_flag: true, grade_gap: 922,
    grade_reason: "vintage: graded EV $1,601 vs raw $680 (+$922) via Value Max — verify centering first",
    net_unit: 688.83, image_url: "https://images.pokemontcg.io/ecard1/9.png" },
  { rarity: "Holo Rare", name: "Charizard", set_name: "Base Set (Unlimited)", number: "4", price: 720.34,
    channel: "eBay (auction)", channel_reason: "scarce/chase — auction realizes above market",
    flags: ["ebay-authenticity-$250+", "tcgp-tracking-$50+", "scarce"], band: "o50", value_tier: "HIGH",
    card_class: "vintage", psa10: 5762.72, psa10_real: true, psa10_x: 8.0, grade_flag: true, grade_gap: 815,
    grade_reason: "vintage: graded EV $1,435 vs raw $620 (+$815) via Value Max — verify centering first",
    net_unit: 619.79, image_url: "https://images.pokemontcg.io/base1/4.png" },
  { rarity: "Secret Rare", name: "Espeon VMAX (Alternate Art Secret)", set_name: "Fusion Strike", number: "270/264", price: 345.42,
    channel: "eBay (auction)", flags: ["ebay-authenticity-$250+", "tcgp-tracking-$50+", "scarce"],
    band: "o50", value_tier: "HIGH", card_class: "modern_textured", psa10: 1036.26, psa10_x: 3.0,
    grade_flag: true, grade_gap: 57, net_unit: 296.86, image_url: "https://images.pokemontcg.io/swsh8/270.png" },
  { rarity: "Special Illustration Rare", name: "Charizard ex", set_name: "SV: 151", number: "199/165", price: 406.14,
    channel: "eBay (auction)", flags: ["ebay-authenticity-$250+", "tcgp-tracking-$50+", "scarce"],
    band: "o50", value_tier: "HIGH", card_class: "modern_textured", psa10: 950.0, psa10_real: true,
    psa10_x: 2.3, net_unit: 349.19, image_url: "https://images.pokemontcg.io/sv3pt5/199.png" },
  { rarity: "Special Illustration Rare", name: "Gengar ex", set_name: "Temporal Forces", number: "247/162", price: 69.23, qty: 3,
    channel: "eBay (fixed)", channel_reason: "$50+ — avoid TCGplayer tracking requirement",
    flags: ["tcgp-tracking-$50+", "scarce"], band: "o50", value_tier: "MID", card_class: "modern_textured",
    psa10: 207.69, psa10_x: 3.0, net_unit: 59.13, image_url: "https://images.pokemontcg.io/sv5/247.png" },
  { rarity: "Illustration Rare", name: "Snorlax", set_name: "Lost Origin Trainer Gallery", number: "TG21/TG30", price: 25.04, qty: 4,
    channel: "TCGplayer", band: "5_50", value_tier: "MID", card_class: "modern_textured",
    psa10: 75.12, psa10_x: 3.0, net_unit: 20.72, image_url: "https://images.pokemontcg.io/swsh11tg/TG21.png" },
  { rarity: "Illustration Rare", name: "Pikachu", set_name: "SV: 151", number: "173/165", price: 42.5,
    channel: "TCGplayer", band: "5_50", value_tier: "MID", card_class: "modern_textured",
    psa10: 127.5, psa10_x: 3.0, net_unit: 35.16, image_url: "https://images.pokemontcg.io/sv3pt5/173.png" },
  { rarity: "Common", name: "Bulbasaur", set_name: "SV: 151", number: "1/165", price: 3.42, qty: 2, variance: "Reverse Holofoil",
    channel: "LCS", channel_reason: "under $5 — local card shop (80/70% trade)", band: "1_5",
    value_tier: "LOW", net_unit: 2.39, image_url: "https://images.pokemontcg.io/sv3pt5/1.png" },
  { rarity: "Illustration Rare", name: "Eevee", set_name: "Twilight Masquerade", number: "188/167", price: 91.41, condition: "LP",
    channel: "eBay (fixed)", flags: ["tcgp-tracking-$50+", "scarce"], band: "o50", value_tier: "MID",
    card_class: "modern_textured", psa10: 274.23, psa10_x: 3.0, net_unit: 77.9,
    image_url: "https://images.pokemontcg.io/sv6/188.png" },
  { rarity: "Super Rare", name: "Sylveon ex (JP)", set_name: "Terastal Festival ex", number: "217/187", price: 147.33,
    channel: "eBay (fixed)", flags: ["tcgp-tracking-$50+", "japanese"], band: "o50", value_tier: "HIGH",
    card_class: "modern_textured", psa10: 441.99, psa10_x: 3.0, net_unit: 125.31, image_url: null },
  // ── Filed piles ──
  { rarity: "Secret Rare", name: "Umbreon VMAX (Alternate Art Secret)", set_name: "Evolving Skies", number: "215/203", price: 420.0,
    keep: true, channel: "eBay (auction)", flags: ["ebay-authenticity-$250+", "scarce"], band: "o50",
    value_tier: "HIGH", card_class: "modern_textured", psa10: 1400, psa10_real: true, psa10_x: 3.3,
    net_unit: 361.1, image_url: "https://images.pokemontcg.io/swsh7/215.png" },
  { rarity: "Secret Rare", name: "Espeon VMAX (Alternate Art Secret)", set_name: "Evolving Skies", number: "214/203", price: 265.0,
    tags: ["to-grade"], channel: "eBay (auction)", flags: ["ebay-authenticity-$250+", "scarce"],
    band: "o50", value_tier: "HIGH", card_class: "modern_textured", psa10: 795, psa10_x: 3.0,
    grade_flag: true, grade_gap: 44, net_unit: 227.4, image_url: "https://images.pokemontcg.io/swsh7/214.png" },
  { rarity: "Double Rare", name: "Mew ex", set_name: "SV: 151", number: "151/165", price: 34.02, tags: ["shop"],
    channel: "TCGplayer", band: "5_50", value_tier: "MID", card_class: "modern_textured",
    psa10: 102.06, psa10_x: 3.0, net_unit: 28.1, image_url: "https://images.pokemontcg.io/sv3pt5/151.png" },
  { rarity: "Special Illustration Rare", name: "Alakazam ex", set_name: "SV: 151", number: "201/165", price: 88.0, tags: ["not-nm"],
    channel: "eBay (fixed)", flags: ["tcgp-tracking-$50+", "scarce"], band: "o50", value_tier: "MID",
    card_class: "modern_textured", psa10: 264, psa10_x: 3.0, net_unit: 74.9, photos: ["front"],
    image_url: "https://images.pokemontcg.io/sv3pt5/201.png" },
  // ── MTG ──
  { bucket: "mtg", name: "Sythis, Harvest's Hand", set_name: "Modern Horizons 2", number: "156", price: 3.41,
    variance: "Normal", channel: "LCS", band: "1_5", value_tier: "LOW", net_unit: 2.39,
    image_url: "https://api.scryfall.com/cards/named?format=image&version=normal&fuzzy=Sythis%20Harvest%27s%20Hand" },
  { bucket: "mtg", name: "The One Ring (Borderless)", set_name: "Universes Beyond: The Lord of the Rings: Tales of Middle-earth", number: "748",
    price: 89.5, variance: "Normal", channel: "eBay (fixed)", flags: ["tcgp-tracking-$50+"], band: "o50",
    value_tier: "MID", net_unit: 76.28,
    image_url: "https://api.scryfall.com/cards/ltr/748?format=image&version=normal" },
  { bucket: "mtg", name: "Blackblade Reforged", set_name: "Commander: Dominaria United", number: "120", price: 3.23,
    variance: "Normal", channel: "LCS", band: "1_5", value_tier: "LOW", net_unit: 2.26,
    image_url: "https://api.scryfall.com/cards/dmc/120?format=image&version=normal" },
  // Foil/Normal pair — same card twice on purpose; the variance line disambiguates
  { bucket: "mtg", name: "Archive Dragon", set_name: "Wilds of Eldraine", number: "41", price: 3.4,
    variance: "Normal", channel: "LCS", band: "1_5", value_tier: "LOW", net_unit: 2.38,
    image_url: "https://api.scryfall.com/cards/woe/41?format=image&version=normal" },
  { bucket: "mtg", name: "Archive Dragon", set_name: "Wilds of Eldraine", number: "41", price: 4.1,
    variance: "Foil", channel: "LCS", band: "1_5", value_tier: "LOW", net_unit: 2.87,
    image_url: "https://api.scryfall.com/cards/woe/41?format=image&version=normal" },
  // ── One Piece ──
  { bucket: "op", rarity: "Secret Rare", name: "Shanks (Alternate Art)", set_name: "Romance Dawn", number: "OP01-120", price: 62.0,
    variance: "Foil", channel: "eBay (fixed)", flags: ["tcgp-tracking-$50+"], band: "o50", value_tier: "MID",
    net_unit: 52.9, image_url: "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/OP01/OP01-120_EN.webp" },
  { bucket: "op", rarity: "Leader", name: "Monkey.D.Luffy", set_name: "Starter Deck 1: Straw Hat Crew", number: "ST01-001", price: 2.8,
    variance: "Normal", channel: "LCS", band: "1_5", value_tier: "BULK", net_unit: 1.96,
    image_url: "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/ST01/ST01-001_EN.webp" },
  // ── YGO ──
  { bucket: "ygo", name: "Mystical Space Typhoon", set_name: "Legend of Blue Eyes White Dragon", number: "MRL-047",
    price: 34.64, variance: "Normal", channel: "TCGplayer", band: "5_50", value_tier: "MID", net_unit: 28.6,
    image_url: "https://images.ygoprodeck.com/images/cards_small/5318639.jpg" },
  { bucket: "ygo", name: "Injection Fairy Lily", set_name: "Legacy of Darkness", number: "LOD-100", price: 21.72,
    variance: "Normal", channel: "TCGplayer", band: "5_50", value_tier: "MID", net_unit: 17.85,
    image_url: "https://images.ygoprodeck.com/images/cards_small/79575620.jpg" },
  // ── Graded (holds) ──
  { bucket: "graded", name: "Charizard ex", set_name: "SV: 151", number: "199/165", grade: "PSA 10.0 GEM - MT",
    price: 1715.78, channel: "", net_unit: 0, image_url: "https://images.pokemontcg.io/sv3pt5/199.png" },
  { bucket: "graded", name: "Rayquaza V (Alternate Full Art)", set_name: "Evolving Skies", number: "194/203",
    grade: "PSA 9.0 MINT", price: 1576.03, channel: "", net_unit: 0,
    image_url: "https://images.pokemontcg.io/swsh7/194.png" },
  { bucket: "graded", name: "Umbreon Gold Star", set_name: "Celebrations: Classic Collection", number: "17/17",
    grade: "PSA 10.0 GEM - MT", price: 469.5, channel: "", net_unit: 0,
    image_url: "https://images.pokemontcg.io/cel25c/17_A.png" },
  // ── Sealed (holds) ──
  { bucket: "sealed", name: "Destined Rivals Pokemon Center Elite Trainer Box (Exclusive)",
    set_name: "Destined Rivals", number: "", grade: "", price: 525.23, channel: "", net_unit: 0, image_url: null },
  { bucket: "sealed", name: "Mega Charizard X ex Ultra Premium Collection",
    set_name: "Miscellaneous", number: "", grade: "", price: 225.66, channel: "", net_unit: 0, image_url: null },
].map(mk).map(fin);
