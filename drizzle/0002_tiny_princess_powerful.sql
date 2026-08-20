ALTER TABLE `document_items` ADD `remark` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `customer` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `contact` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `remark` text DEFAULT '' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`code_source` text DEFAULT 'auto' NOT NULL,
	`name` text NOT NULL,
	`unit` text DEFAULT '件' NOT NULL,
	`status` text DEFAULT 'normal' NOT NULL,
	`min_stock` integer DEFAULT 0 NOT NULL,
	`max_stock` integer DEFAULT 0 NOT NULL,
	`current_stock` integer DEFAULT 0 NOT NULL,
	`average_cost_cents` integer DEFAULT 0 NOT NULL,
	`default_supplier_id` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`default_supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "products_current_stock_nonnegative" CHECK("__new_products"."current_stock" >= 0),
	CONSTRAINT "products_min_stock_nonnegative" CHECK("__new_products"."min_stock" >= 0),
	CONSTRAINT "products_max_stock_nonnegative" CHECK("__new_products"."max_stock" >= 0),
	CONSTRAINT "products_max_stock_not_below_min_stock" CHECK("__new_products"."max_stock" >= "__new_products"."min_stock")
);
--> statement-breakpoint
-- Existing products had no upper limit. Migrating to max = min preserves the
-- prior behavior and avoids inventing a purchasing quantity.
INSERT INTO `__new_products`("id", "code", "code_source", "name", "unit", "status", "min_stock", "max_stock", "current_stock", "average_cost_cents", "default_supplier_id", "archived_at", "created_at", "updated_at") SELECT "id", "code", "code_source", "name", "unit", "status", "min_stock", "min_stock", "current_stock", "average_cost_cents", "default_supplier_id", "archived_at", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_unique` ON `products` (`code`);--> statement-breakpoint
CREATE INDEX `idx_products_archived_name` ON `products` (`archived_at`,`name`);
