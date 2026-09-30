SET SESSION max_statement_time = 30;
SET SESSION TRANSACTION READ ONLY;
START TRANSACTION READ ONLY;
-- S8 v1 CommercialPriceCalculator rounding change (7a214f4 -> 47875d5) on currently applicable public percentage rows, shop 1, 19 %
SELECT COUNT(*) AS priced_units_with_active_percentage,
       SUM(old_gross <> new_gross) AS units_changed, MIN(new_gross - old_gross) AS min_delta_clp, MAX(new_gross - old_gross) AS max_delta_clp
FROM (
  SELECT ROUND(ROUND((ps.price + COALESCE(pas.price, 0)) * 1.19, 0) * (1 - sp.reduction), 0) AS old_gross,
         ROUND((ps.price + COALESCE(pas.price, 0)) * (1 - sp.reduction) * 1.19, 0) AS new_gross
  FROM ps_specific_price sp
  JOIN ps_product_shop ps ON ps.id_product = sp.id_product AND ps.id_shop = 1 AND ps.active = 1
  LEFT JOIN ps_product_attribute pa ON pa.id_product = sp.id_product AND (sp.id_product_attribute = 0 OR pa.id_product_attribute = sp.id_product_attribute)
  LEFT JOIN ps_product_attribute_shop pas ON pas.id_product_attribute = pa.id_product_attribute AND pas.id_shop = 1
  WHERE sp.id_cart = 0 AND sp.id_customer = 0 AND sp.id_group = 0 AND sp.id_country = 0 AND sp.id_currency = 0
    AND sp.id_shop IN (0, 1) AND sp.reduction_type = 'percentage' AND sp.price < 0 AND sp.from_quantity <= 1
    AND (sp.`from` = '0000-00-00 00:00:00' OR sp.`from` <= UTC_TIMESTAMP() - INTERVAL 3 HOUR)
    AND (sp.`to` = '0000-00-00 00:00:00' OR sp.`to` >= UTC_TIMESTAMP() - INTERVAL 3 HOUR)
) x;
COMMIT;
