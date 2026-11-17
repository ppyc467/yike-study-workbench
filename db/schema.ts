import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** One private workspace per authenticated identity. Revision guards every write. */
export const studyWorkspaces = sqliteTable("study_workspaces", {
  userId: text("user_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(0),
  lastMutationId: text("last_mutation_id"),
  writeToken: text("write_token"),
  updatedAt: integer("updated_at").notNull(),
});

export const studyWorkspaceRecords = sqliteTable("study_workspace_records", {
  userId: text("user_id").notNull().references(() => studyWorkspaces.userId, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  recordId: text("record_id").notNull(),
  position: integer("position").notNull(),
  recordJson: text("record_json").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.kind, table.recordId] })]);

export const taskChatConversations = sqliteTable("task_chat_conversations", {
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  memory: text("memory").notNull().default(""),
  memoryRevision: integer("memory_revision").notNull().default(0),
  activeOperationId: text("active_operation_id"),
  leaseToken: text("lease_token"),
  leaseUntil: integer("lease_until").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.taskId] })]);

export const taskChatTurns = sqliteTable("task_chat_turns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  operationId: text("operation_id").notNull(),
  message: text("message").notNull(),
  reply: text("reply"),
  status: text("status", { enum: ["pending", "failed", "complete"] }).notNull(),
  leaseToken: text("lease_token").notNull(),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  error: text("error"),
}, table => [
  foreignKey({ columns: [table.userId, table.taskId], foreignColumns: [taskChatConversations.userId, taskChatConversations.taskId] }).onDelete("cascade"),
  uniqueIndex("task_chat_turns_operation").on(table.userId, table.taskId, table.operationId),
  index("task_chat_turns_history").on(table.userId, table.taskId, table.id),
]);
