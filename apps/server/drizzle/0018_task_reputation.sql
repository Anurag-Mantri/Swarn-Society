CREATE TABLE "task_reputation_reviews" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"feedback" text,
	"tests" text,
	"merged_pull_request" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_reputation_feedback_valid" CHECK ("task_reputation_reviews"."feedback" in ('helpful', 'needs_work')),
	CONSTRAINT "task_reputation_tests_valid" CHECK ("task_reputation_reviews"."tests" in ('passed', 'failed')),
	CONSTRAINT "task_reputation_has_evidence" CHECK (num_nonnulls("task_reputation_reviews"."feedback", "task_reputation_reviews"."tests", "task_reputation_reviews"."merged_pull_request") >= 1)
);
--> statement-breakpoint
ALTER TABLE "task_reputation_reviews" ADD CONSTRAINT "task_reputation_reviews_task_id_task_posts_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reputation_reviews" ADD CONSTRAINT "task_reputation_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;