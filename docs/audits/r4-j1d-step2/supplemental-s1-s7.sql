SET SESSION max_statement_time = 30;
SET SESSION TRANSACTION READ ONLY;
START TRANSACTION READ ONLY;
-- S1 meaningful-category coverage (active visible products, active trust-map categories)
SELECT COUNT(*) AS active_visible_products, SUM(has_meaningful) AS with_meaningful_category, SUM(1-has_meaningful) AS category_null
FROM (SELECT ps.id_product, MAX(cp.id_category IS NOT NULL) AS has_meaningful
      FROM ps_product_shop ps LEFT JOIN ps_category_product cp ON cp.id_product = ps.id_product AND cp.id_category IN (248,249,250,251,252,253,254,255,256,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,285,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,305,306,307,308,309,310,311,312,313,314,315,317,318,319,320,321,322,323,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,359,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,380,381,382,383,384,385,386,387,389,390,391,424,425,426,427,428,429,430,431,432,433,434,435,436,437,438,439,440,441,442,443,444,445,446,447,448,449,450,451,465,467,468,472,478,494,495,496,497,500)
      WHERE ps.id_shop = 1 AND ps.active = 1 AND ps.visibility <> 'none' GROUP BY ps.id_product) x;
-- S2a specific_price scope the reader cannot see or the context would exclude (all non-cart rows, any date)
SELECT (id_product = 0) AS all_products_row, id_shop, id_shop_group, id_currency, id_country, id_group, (id_customer<>0) AS customer_scoped, COUNT(*) AS rows_count
FROM ps_specific_price WHERE id_cart = 0 GROUP BY 1,2,3,4,5,6,7 ORDER BY rows_count DESC;
-- S2b percentage/amount reduction ranges and from_quantity (non-cart rows)
SELECT reduction_type, MIN(reduction) AS min_red, MAX(reduction) AS max_red, MIN(from_quantity) AS min_fq, MAX(from_quantity) AS max_fq, MIN(price) AS min_price, MAX(price) AS max_price, COUNT(*) AS n
FROM ps_specific_price WHERE id_cart = 0 GROUP BY reduction_type;
-- S2c products with >1 public row applicable now in shop-local time (any shop scope), and future-starting rows
SELECT COUNT(*) AS products_with_multiple_applicable_rows, COALESCE(MAX(n),0) AS max_rows
FROM (SELECT id_product, id_product_attribute, COUNT(*) AS n FROM ps_specific_price
      WHERE id_cart = 0 AND id_customer = 0 AND id_shop IN (0,1)
        AND (`from` = '0000-00-00 00:00:00' OR `from` <= UTC_TIMESTAMP() - INTERVAL 3 HOUR)
        AND (`to` = '0000-00-00 00:00:00' OR `to` >= UTC_TIMESTAMP() - INTERVAL 3 HOUR)
      GROUP BY id_product, id_product_attribute HAVING COUNT(*) > 1) x;
SELECT SUM(`from` > UTC_TIMESTAMP() - INTERVAL 3 HOUR) AS future_start_rows,
       SUM(`to` <> '0000-00-00 00:00:00' AND `to` >= UTC_TIMESTAMP() - INTERVAL 3 HOUR) AS bounded_end_active_rows,
       MIN(NULLIF(`from`,'0000-00-00 00:00:00')) AS min_from, MAX(NULLIF(`to`,'0000-00-00 00:00:00')) AS max_to
FROM ps_specific_price WHERE id_cart = 0;
SELECT TIME(`from`) AS from_time, TIME(`to`) AS to_time, COUNT(*) AS n FROM ps_specific_price
WHERE id_cart = 0 AND (`from` <> '0000-00-00 00:00:00' OR `to` <> '0000-00-00 00:00:00') GROUP BY 1,2 ORDER BY n DESC LIMIT 10;
-- S3 contract text bounds not covered by B8 (sku 1..64, brand 1..64, names 1..128)
SELECT MAX(CHAR_LENGTH(TRIM(p.reference))) AS max_product_sku_len, SUM(CHAR_LENGTH(TRIM(p.reference)) > 64) AS product_sku_over_64
FROM ps_product p JOIN ps_product_shop ps ON ps.id_product = p.id_product AND ps.id_shop = 1 AND ps.active = 1;
SELECT MAX(CHAR_LENGTH(TRIM(pa.reference))) AS max_variant_sku_len, SUM(CHAR_LENGTH(TRIM(pa.reference)) > 64) AS variant_sku_over_64
FROM ps_product_attribute pa JOIN ps_product_shop ps ON ps.id_product = pa.id_product AND ps.id_shop = 1 AND ps.active = 1;
SELECT MAX(CHAR_LENGTH(TRIM(m.name))) AS max_brand_len, SUM(CHAR_LENGTH(TRIM(m.name)) > 64) AS brand_over_64 FROM ps_manufacturer m;
SELECT (SELECT MAX(CHAR_LENGTH(name)) FROM ps_feature_lang WHERE id_lang=1) AS max_feature_name_len,
       (SELECT MAX(CHAR_LENGTH(name)) FROM ps_attribute_lang WHERE id_lang=1) AS max_attribute_value_len,
       (SELECT MAX(CHAR_LENGTH(name)) FROM ps_attribute_group_lang WHERE id_lang=1) AS max_attribute_group_len,
       (SELECT MAX(CHAR_LENGTH(name)) FROM ps_category_lang WHERE id_lang=1) AS max_category_name_len;
-- S4 timezone corroboration: latest PHP-written timestamps vs DB UTC (aggregate only)
SELECT UTC_TIMESTAMP() AS db_utc_now,
       (SELECT MAX(date_add) FROM ps_connections) AS max_connection_date_add,
       (SELECT MAX(date_add) FROM ps_cart) AS max_cart_date_add,
       (SELECT MAX(date_add) FROM ps_orders) AS max_order_date_add,
       (SELECT MAX(date_upd) FROM ps_product) AS max_product_date_upd;
-- S5 search amplification upper bound (reader has no row cap; it does not filter by active)
SELECT (SELECT COUNT(*) FROM ps_product) AS all_products, (SELECT COUNT(*) FROM ps_product_lang WHERE id_lang=1 AND id_shop=1) AS product_lang_rows,
       (SELECT COUNT(*) FROM ps_product_attribute) AS all_combinations, (SELECT COUNT(*) FROM ps_specific_price) AS all_specific_prices;
-- S6 shops
SELECT COUNT(*) AS shops, SUM(active) AS active_shops FROM ps_shop;
COMMIT;
SET SESSION max_statement_time = 30;
SET SESSION TRANSACTION READ ONLY;
START TRANSACTION READ ONLY;
-- S7 multi-shop topology
SELECT s.id_shop, s.id_shop_group, s.name, s.active, su.domain, su.physical_uri, su.main FROM ps_shop s LEFT JOIN ps_shop_url su ON su.id_shop = s.id_shop ORDER BY s.id_shop;
SELECT id_shop_group, name, share_customer, share_order, share_stock, active FROM ps_shop_group;
SELECT sa.id_shop, sa.id_shop_group, COUNT(*) AS stock_rows FROM ps_stock_available sa GROUP BY sa.id_shop, sa.id_shop_group;
SELECT ps.id_shop, SUM(ps.active=1) AS active_products, COUNT(*) AS products FROM ps_product_shop ps GROUP BY ps.id_shop;
SELECT id_shop, name, value FROM (SELECT id_shop, name, value FROM ps_configuration WHERE name IN ('PS_TIMEZONE','PS_ORDER_OUT_OF_STOCK','PS_SPECIFIC_PRICE_PRIORITIES','PS_TAX','PS_SHOP_DEFAULT','PS_MULTISHOP_FEATURE_ACTIVE')) x ORDER BY name, id_shop;
COMMIT;
