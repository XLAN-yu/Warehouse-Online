CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text DEFAULT '' NOT NULL,
	`after_json` text DEFAULT '' NOT NULL,
	`operator_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`operator_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_items` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`counted_quantity` integer,
	`unit_price_cents` integer DEFAULT 0 NOT NULL,
	`unit_cost_cents` integer DEFAULT 0 NOT NULL,
	`before_quantity` integer DEFAULT 0 NOT NULL,
	`after_quantity` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`document_no` text NOT NULL,
	`type` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`supplier_id` text,
	`external_ref` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision_of` text,
	`operator_user_id` text NOT NULL,
	`effective_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operator_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_document_no_unique` ON `documents` (`document_no`);--> statement-breakpoint
CREATE TABLE `inventory_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_suppliers` (
	`product_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`product_id`, `supplier_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`code_source` text DEFAULT 'auto' NOT NULL,
	`name` text NOT NULL,
	`unit` text DEFAULT '件' NOT NULL,
	`status` text DEFAULT 'normal' NOT NULL,
	`min_stock` integer DEFAULT 0 NOT NULL,
	`current_stock` integer DEFAULT 0 NOT NULL,
	`average_cost_cents` integer DEFAULT 0 NOT NULL,
	`default_supplier_id` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`default_supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_unique` ON `products` (`code`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_name_unique` ON `suppliers` (`name`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);