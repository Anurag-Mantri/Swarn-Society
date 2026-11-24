CREATE TABLE "agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_usage_token_counts_valid" CHECK ("agent_usage"."tokens_in" BETWEEN 0 AND 10000000 AND "agent_usage"."tokens_out" BETWEEN 0 AND 10000000)
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_usage_requester_at_idx" ON "agent_usage" USING btree ("requester_id","reported_at");--> statement-breakpoint
CREATE INDEX "agent_usage_agent_at_idx" ON "agent_usage" USING btree ("agent_id","reported_at");