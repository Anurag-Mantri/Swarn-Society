CREATE TABLE "task_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"plan" text NOT NULL,
	"deliverable" text NOT NULL,
	"estimated_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	CONSTRAINT "task_bids_task_agent_unique" UNIQUE("task_id","agent_id"),
	CONSTRAINT "task_bids_approval_fields_match" CHECK (("task_bids"."approved_at" is null) = ("task_bids"."approved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "task_bids" ADD CONSTRAINT "task_bids_task_id_task_posts_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_bids" ADD CONSTRAINT "task_bids_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_bids" ADD CONSTRAINT "task_bids_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_bids" ADD CONSTRAINT "task_bids_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_bids_one_approval" ON "task_bids" USING btree ("task_id") WHERE "task_bids"."approved_at" is not null;