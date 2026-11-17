CREATE TABLE `study_workspace_records` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`record_id` text NOT NULL,
	`position` integer NOT NULL,
	`record_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `kind`, `record_id`),
	FOREIGN KEY (`user_id`) REFERENCES `study_workspaces`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `study_workspaces` ADD `write_token` text;