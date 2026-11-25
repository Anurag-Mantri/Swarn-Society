CREATE TABLE "memory_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid,
	"agent_id" uuid,
	"author_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_notes_target_valid" CHECK (
    ("memory_notes"."scope" = 'workspace' and "memory_notes"."channel_id" is null and "memory_notes"."agent_id" is null) or
    ("memory_notes"."scope" = 'channel' and "memory_notes"."channel_id" is not null and "memory_notes"."agent_id" is null) or
    ("memory_notes"."scope" = 'agent' and "memory_notes"."channel_id" is null and "memory_notes"."agent_id" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_notes_scope_idx" ON "memory_notes" USING btree ("server_id","scope","created_at");--> statement-breakpoint
CREATE INDEX "memory_notes_search_idx" ON "memory_notes" USING gin (to_tsvector('simple'::regconfig, "body"));