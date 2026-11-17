CREATE TABLE `study_workspaces` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_mutation_id` text,
	`updated_at` integer NOT NULL
);
