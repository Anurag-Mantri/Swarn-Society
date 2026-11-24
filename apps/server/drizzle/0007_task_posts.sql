CREATE TABLE "task_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_agent_id" uuid,
	CONSTRAINT "task_posts_claim_fields_match" CHECK (("task_posts"."claimed_at" is null) = ("task_posts"."claimed_by_agent_id" is null))
);
--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_posts" ADD CONSTRAINT "task_posts_claimed_by_agent_id_agents_id_fk" FOREIGN KEY ("claimed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_posts_channel_created_idx" ON "task_posts" USING btree ("channel_id","created_at");