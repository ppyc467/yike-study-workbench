CREATE TABLE `task_chat_conversations` (
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`memory` text DEFAULT '' NOT NULL,
	`memory_revision` integer DEFAULT 0 NOT NULL,
	`active_operation_id` text,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `task_id`)
);
--> statement-breakpoint
CREATE TABLE `task_chat_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`message` text NOT NULL,
	`reply` text,
	`status` text NOT NULL,
	`lease_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`user_id`,`task_id`) REFERENCES `task_chat_conversations`(`user_id`,`task_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_chat_turns_operation` ON `task_chat_turns` (`user_id`,`task_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `task_chat_turns_history` ON `task_chat_turns` (`user_id`,`task_id`,`id`);
--> statement-breakpoint
CREATE TRIGGER `task_chat_remove_deleted_tasks`
AFTER UPDATE OF `state_json` ON `study_workspaces`
BEGIN
  DELETE FROM `task_chat_conversations`
  WHERE `user_id` = NEW.`user_id`
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.`state_json`, '$.tasks') task
    WHERE json_extract(task.value, '$.id') = `task_chat_conversations`.`task_id`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `task_chat_remove_deleted_workspaces`
AFTER DELETE ON `study_workspaces`
BEGIN
  DELETE FROM `task_chat_conversations` WHERE `user_id` = OLD.`user_id`;
END;
