ALTER TABLE "task_posts" ADD COLUMN "intent" text;--> statement-breakpoint
UPDATE "task_posts" SET "intent" = lower(regexp_replace(btrim("title"), '[[:space:]]+', ' ', 'g'));--> statement-breakpoint
ALTER TABLE "task_posts" ALTER COLUMN "intent" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "task_posts_active_agent_idx" ON "task_posts" USING btree ("claimed_by_agent_id") WHERE "task_posts"."resolution" is null and "task_posts"."claimed_by_agent_id" is not null;--> statement-breakpoint
CREATE INDEX "task_posts_active_intent_idx" ON "task_posts" USING btree ("channel_id","intent") WHERE "task_posts"."resolution" is null and "task_posts"."claimed_by_agent_id" is not null;