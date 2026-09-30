SET SESSION max_statement_time = 30;
SET SESSION TRANSACTION READ ONLY;
START TRANSACTION READ ONLY;

-- =====================================================================
-- BLOCKING BEFORE LIVE
-- =====================================================================

-- B1. Schema compatibility of every column the v2 reader uses.
-- (J1C found `ps_feature_value.custom_value` referenced by the J1A reader; it
-- does not exist in PrestaShop core and made every v2 read fail. This proves
-- the corrected reader's columns exist in production.)
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME, COLUMN_NAME) IN (
    ('ps_product','id_product'),('ps_product','reference'),('ps_product','price'),('ps_product','weight'),('ps_product','active'),
    ('ps_product','available_for_order'),('ps_product','id_category_default'),('ps_product','id_manufacturer'),
    ('ps_product_shop','price'),('ps_product_shop','active'),('ps_product_shop','visibility'),('ps_product_shop','available_for_order'),('ps_product_shop','id_tax_rules_group'),
    ('ps_product_lang','name'),('ps_product_lang','description_short'),('ps_product_lang','description'),('ps_product_lang','link_rewrite'),('ps_product_lang','id_shop'),
    ('ps_category_lang','name'),('ps_category_lang','id_shop'),('ps_manufacturer','name'),
    ('ps_product_attribute','reference'),('ps_product_attribute','price'),('ps_product_attribute','default_on'),
    ('ps_product_attribute_shop','price'),('ps_product_attribute_combination','id_attribute'),
    ('ps_attribute','id_attribute_group'),('ps_attribute_lang','name'),('ps_attribute_group_lang','name'),
    ('ps_stock_available','quantity'),('ps_stock_available','out_of_stock'),('ps_stock_available','id_shop'),
    ('ps_feature','position'),('ps_feature_lang','name'),('ps_feature_product','id_feature_value'),('ps_feature_value','custom'),('ps_feature_value_lang','value'),
    ('ps_specific_price','reduction_tax'),('ps_specific_price','reduction_type'),('ps_specific_price','from'),('ps_specific_price','to'),('ps_specific_price','id_cart'),
    ('ps_configuration','name'),('ps_configuration','value'),
    -- [J1D] meaningful category source
    ('ps_category','id_category'),('ps_category','level_depth'),('ps_category','active'),
    ('ps_category_product','id_category'),('ps_category_product','id_product'))
ORDER BY TABLE_NAME, COLUMN_NAME;
SELECT name, value FROM ps_configuration WHERE name IN ('PS_VERSION_DB', 'PS_INSTALL_VERSION');

-- B2. Tax rules group distribution over SELLABLE products (the contract declares configured_flat_rate).
SELECT ps.id_tax_rules_group, COUNT(*) AS products
FROM ps_product_shop ps
WHERE ps.id_shop = 1 AND ps.active = 1 AND ps.visibility <> 'none' AND ps.available_for_order = 1
GROUP BY ps.id_tax_rules_group
ORDER BY products DESC;

-- B3. Effective tax rate of each group used by sellable products (country of the public context).
SELECT trg.id_tax_rules_group, trg.name AS rules_group, trg.active AS group_active, tr.id_country, c.iso_code,
       tr.id_state, tr.zipcode_from, tr.zipcode_to, tr.behavior, t.id_tax, t.rate, t.active AS tax_active
FROM ps_tax_rules_group trg
LEFT JOIN ps_tax_rule tr ON tr.id_tax_rules_group = trg.id_tax_rules_group
LEFT JOIN ps_tax t ON t.id_tax = tr.id_tax
LEFT JOIN ps_country c ON c.id_country = tr.id_country
WHERE trg.id_tax_rules_group IN (SELECT DISTINCT id_tax_rules_group FROM ps_product_shop WHERE id_shop = 1 AND active = 1)
ORDER BY trg.id_tax_rules_group, tr.id_country, tr.id_state;
SELECT name, value FROM ps_configuration
WHERE name IN ('PS_TAX', 'PS_COUNTRY_DEFAULT', 'PS_CURRENCY_DEFAULT', 'PS_PRICE_ROUND_MODE', 'PS_ROUND_TYPE', 'PS_PRICE_DISPLAY_PRECISION', 'PS_TAX_DISPLAY', 'PS_CUSTOMER_GROUP', 'PS_UNIDENTIFIED_GROUP', 'PS_GUEST_GROUP');

-- B4. Specific prices that can apply now: reduction basis and scope (reduction_tax=0 amounts are net).
SELECT sp.reduction_type, sp.reduction_tax,
       (sp.price >= 0) AS fixed_price_override,
       (sp.id_customer <> 0) AS customer_scoped, (sp.id_group <> 0) AS group_scoped,
       (sp.id_currency <> 0) AS currency_scoped, (sp.id_country <> 0) AS country_scoped,
       (sp.id_product_attribute <> 0) AS combination_scoped, (sp.from_quantity > 1) AS quantity_tier,
       (sp.id_specific_price_rule <> 0) AS from_catalog_rule, (sp.id_shop = 0) AS all_shops,
       SUM(sp.`from` = '0000-00-00 00:00:00') AS unbounded_start, SUM(sp.`to` = '0000-00-00 00:00:00') AS unbounded_end,
       COUNT(*) AS rows_count
FROM ps_specific_price sp
WHERE sp.id_cart = 0
  AND (sp.`to` = '0000-00-00 00:00:00' OR sp.`to` >= NOW())
GROUP BY 1,2,3,4,5,6,7,8,9,10,11
ORDER BY rows_count DESC;

-- B5. Potential specific-price ties for the PUBLIC context (customer 0): several rows equally specific
-- for the same product/combination/quantity. The engine breaks ties by id; PrestaShop's own priority
-- (PS_SPECIFIC_PRICE_PRIORITIES) must be confirmed to agree.
SELECT sp.id_product, sp.id_product_attribute, sp.id_shop, sp.id_currency, sp.id_country, sp.id_group, sp.from_quantity,
       COUNT(*) AS candidates, GROUP_CONCAT(sp.id_specific_price ORDER BY sp.id_specific_price) AS ids,
       GROUP_CONCAT(CONCAT(sp.reduction_type, ':', sp.reduction, ':', sp.reduction_tax) ORDER BY sp.id_specific_price) AS reductions
FROM ps_specific_price sp
WHERE sp.id_cart = 0 AND sp.id_customer = 0
  AND (sp.`from` = '0000-00-00 00:00:00' OR sp.`from` <= NOW())
  AND (sp.`to` = '0000-00-00 00:00:00' OR sp.`to` >= NOW())
GROUP BY sp.id_product, sp.id_product_attribute, sp.id_shop, sp.id_currency, sp.id_country, sp.id_group, sp.from_quantity
HAVING COUNT(*) > 1
ORDER BY candidates DESC
LIMIT 200;
SELECT name, value FROM ps_configuration WHERE name = 'PS_SPECIFIC_PRICE_PRIORITIES';

-- B6. Effective out-of-stock / backorder configuration.
SELECT name, value FROM ps_configuration WHERE name IN ('PS_ORDER_OUT_OF_STOCK', 'PS_STOCK_MANAGEMENT', 'PS_ADVANCED_STOCK_MANAGEMENT', 'PS_DISPLAY_QTIES', 'PS_PACK_STOCK_TYPE');
SELECT sa.out_of_stock, (sa.quantity <= 0) AS zero_or_less, (sa.id_product_attribute <> 0) AS combination_row, COUNT(*) AS rows_count
FROM ps_stock_available sa
JOIN ps_product_shop ps ON ps.id_product = sa.id_product AND ps.id_shop = 1 AND ps.active = 1 AND ps.visibility <> 'none'
WHERE sa.id_shop = 1
GROUP BY sa.out_of_stock, zero_or_less, combination_row
ORDER BY rows_count DESC;
-- Sellable products with NO stock_available row for their sellable unit (→ stock_unknown).
SELECT COUNT(*) AS simple_products_without_stock_row
FROM ps_product_shop ps
WHERE ps.id_shop = 1 AND ps.active = 1
  AND NOT EXISTS (SELECT 1 FROM ps_product_attribute pa WHERE pa.id_product = ps.id_product)
  AND NOT EXISTS (SELECT 1 FROM ps_stock_available sa WHERE sa.id_product = ps.id_product AND sa.id_product_attribute = 0 AND sa.id_shop = 1);

-- B7. Datetime semantics: PrestaShop stores shop-local datetimes. [J1D] The v2 reader reads specific-price
-- windows as text and converts them with PRESTASHOP_TIMEZONE (default UTC): deployment must set it to PS_TIMEZONE.
-- Promotion windows and freshness.validUntil depend on this.
SELECT @@global.time_zone AS global_tz, @@session.time_zone AS session_tz, NOW() AS db_now, UTC_TIMESTAMP() AS db_utc_now;
SELECT name, value FROM ps_configuration WHERE name = 'PS_TIMEZONE';

-- B8. Contract bounds against real data (consumers reject, never truncate):
--     variantOptions <= 100, attributes per variant <= 10, specifications <= 40, names 1..128.
SELECT MAX(c) AS max_combinations_per_product, SUM(c > 100) AS products_over_100
FROM (SELECT pa.id_product, COUNT(*) AS c FROM ps_product_attribute pa JOIN ps_product_shop ps ON ps.id_product = pa.id_product AND ps.id_shop = 1 AND ps.active = 1 GROUP BY pa.id_product) x;
SELECT MAX(c) AS max_attributes_per_combination FROM (SELECT id_product_attribute, COUNT(*) AS c FROM ps_product_attribute_combination GROUP BY id_product_attribute) x;
SELECT MAX(c) AS max_features_per_product, SUM(c > 40) AS products_over_40 FROM (SELECT id_product, COUNT(*) AS c FROM ps_feature_product GROUP BY id_product) x;
SELECT SUM(TRIM(pl.name) = '') AS empty_names, MAX(CHAR_LENGTH(pl.name)) AS max_name_len
FROM ps_product_lang pl JOIN ps_product_shop ps ON ps.id_product = pl.id_product AND ps.id_shop = 1 AND ps.active = 1
WHERE pl.id_lang = 1 AND pl.id_shop = 1;
SELECT SUM(fvl.value IS NULL OR TRIM(fvl.value) = '') AS empty_feature_values, MAX(CHAR_LENGTH(fvl.value)) AS max_feature_value_len
FROM ps_feature_value_lang fvl WHERE fvl.id_lang = 1;

-- B9. [J1D-CAT-02] Meaningful category evidence. The service embeds the audited trust map
-- (src/domain/catalog/v2/categoryTrustMap.ts, keyed by these production ids).
-- (a) default category of sellable products (expected: 2 / CATEGORÍAS for the whole catalog):
SELECT ps.id_category_default, cl.name, COUNT(*) AS products
FROM ps_product_shop ps
LEFT JOIN ps_category_lang cl ON cl.id_category = ps.id_category_default AND cl.id_lang = 1 AND cl.id_shop = 1
WHERE ps.id_shop = 1 AND ps.active = 1 AND ps.visibility <> 'none'
GROUP BY ps.id_category_default, cl.name ORDER BY products DESC LIMIT 20;
-- (b) the trust map is still valid: ids of the embedded map that are missing, inactive or renamed in production
--     (compare the returned names with the map comments; any drift → regenerate the map, rerun gates):
SELECT c.id_category, c.active, c.level_depth, cl.name
FROM ps_category c JOIN ps_category_lang cl ON cl.id_category = c.id_category AND cl.id_lang = 1 AND cl.id_shop = 1
WHERE c.id_category IN (SELECT id_category FROM ps_category_product) ORDER BY c.id_category;
-- (c) sellable products per number of assigned categories (0 → category null):
SELECT n_categories, COUNT(*) AS products FROM (
  SELECT ps.id_product, COUNT(cp.id_category) AS n_categories
  FROM ps_product_shop ps LEFT JOIN ps_category_product cp ON cp.id_product = ps.id_product
  WHERE ps.id_shop = 1 AND ps.active = 1 AND ps.visibility <> 'none' GROUP BY ps.id_product
) x GROUP BY n_categories ORDER BY n_categories;

-- =====================================================================
-- DIAGNOSTIC / NON-BLOCKING
-- =====================================================================

-- D1. [J1D: BLOCKING for J1D-CAT-01] Collation of the searched columns. Token retrieval sends
-- accent-stripped lowercase tokens; it requires a case- AND accent-insensitive collation (*_ci, not *_bin/_as_).
SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME, COLUMN_NAME) IN (('ps_product','reference'),('ps_product_lang','name'),('ps_product_lang','description_short'),('ps_product_lang','description'),('ps_product_attribute','reference'));
SELECT @@global.sql_mode AS global_sql_mode;

COMMIT;
