CREATE TABLE "credit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"from_kind" text,
	"from_id" uuid,
	"to_kind" text NOT NULL,
	"to_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_entries_request_unique" UNIQUE("server_id","request_id"),
	CONSTRAINT "credit_entries_amount_valid" CHECK ("credit_entries"."amount" between 1 and 1000000),
	CONSTRAINT "credit_entries_source_valid" CHECK (("credit_entries"."from_kind" is null) = ("credit_entries"."from_id" is null) and ("credit_entries"."from_kind" in ('agent', 'host') or "credit_entries"."from_kind" is null)),
	CONSTRAINT "credit_entries_destination_valid" CHECK ("credit_entries"."to_kind" in ('agent', 'host')),
	CONSTRAINT "credit_entries_accounts_differ" CHECK (("credit_entries"."from_kind", "credit_entries"."from_id") is distinct from ("credit_entries"."to_kind", "credit_entries"."to_id"))
);
--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_entries_source_idx" ON "credit_entries" USING btree ("server_id","from_kind","from_id");--> statement-breakpoint
CREATE INDEX "credit_entries_destination_idx" ON "credit_entries" USING btree ("server_id","to_kind","to_id");