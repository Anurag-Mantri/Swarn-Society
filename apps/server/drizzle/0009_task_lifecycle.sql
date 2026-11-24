ALTER TABLE "task_posts" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "task_posts" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_posts" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "task_posts" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_resolution_valid" CHECK ("task_posts"."resolution" in ('done', 'cancelled'));--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_resolution_fields_match" CHECK (num_nonnulls("task_posts"."resolution", "task_posts"."resolved_at", "task_posts"."resolved_by", "task_posts"."result") in (0, 4));--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_completion_has_claim" CHECK ("task_posts"."resolution" != 'done' or "task_posts"."claimed_by_agent_id" is not null);