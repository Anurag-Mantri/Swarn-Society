ALTER TABLE "task_posts" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "task_posts" ADD COLUMN "delegation_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_channel_id_unique" UNIQUE("channel_id","id");--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_parent_channel_fk" FOREIGN KEY ("channel_id","parent_task_id") REFERENCES "public"."task_posts"("channel_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_posts_parent_idx" ON "task_posts" USING btree ("channel_id","parent_task_id");--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_delegation_depth_valid" CHECK ("task_posts"."delegation_depth" between 0 and 3);--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_parent_required" CHECK (("task_posts"."parent_task_id" is null) = ("task_posts"."delegation_depth" = 0));--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_parent_not_self" CHECK ("task_posts"."parent_task_id" <> "task_posts"."id");
