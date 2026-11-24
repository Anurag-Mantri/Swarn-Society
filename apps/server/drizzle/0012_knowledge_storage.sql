ALTER TABLE "channels" ADD CONSTRAINT "channels_server_id_id_unique" UNIQUE("server_id","id");--> statement-breakpoint
CREATE TABLE "knowledge_edge_sources" (
	"server_id" uuid NOT NULL,
	"edge_id" text NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "knowledge_edge_sources_server_id_edge_id_source_id_pk" PRIMARY KEY("server_id","edge_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"relation" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "knowledge_edges_scoped_id" UNIQUE("server_id","id"),
	CONSTRAINT "knowledge_edges_relationship" UNIQUE("server_id","from_node_id","relation","to_node_id"),
	CONSTRAINT "knowledge_edges_confidence_valid" CHECK ("knowledge_edges"."confidence" between 0 and 100),
	CONSTRAINT "knowledge_edges_method_valid" CHECK ("knowledge_edges"."method" in ('deterministic', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_node_sources" (
	"server_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "knowledge_node_sources_server_id_node_id_source_id_pk" PRIMARY KEY("server_id","node_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"canonical_key" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "knowledge_nodes_scoped_id" UNIQUE("server_id","id"),
	CONSTRAINT "knowledge_nodes_canonical_key" UNIQUE("server_id","kind","canonical_key"),
	CONSTRAINT "knowledge_nodes_confidence_valid" CHECK ("knowledge_nodes"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "knowledge_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"edge_id" text NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_reviews_decision_valid" CHECK ("knowledge_reviews"."decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"method" text NOT NULL,
	"event" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_scoped_id" UNIQUE("server_id","id"),
	CONSTRAINT "knowledge_sources_identity" UNIQUE("server_id","source_type","source_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_edge_sources" ADD CONSTRAINT "knowledge_edge_sources_edge_scope_fk" FOREIGN KEY ("server_id","edge_id") REFERENCES "public"."knowledge_edges"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edge_sources" ADD CONSTRAINT "knowledge_edge_sources_source_scope_fk" FOREIGN KEY ("server_id","source_id") REFERENCES "public"."knowledge_sources"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_node_scope_fk" FOREIGN KEY ("server_id","from_node_id") REFERENCES "public"."knowledge_nodes"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_node_scope_fk" FOREIGN KEY ("server_id","to_node_id") REFERENCES "public"."knowledge_nodes"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_sources" ADD CONSTRAINT "knowledge_node_sources_node_scope_fk" FOREIGN KEY ("server_id","node_id") REFERENCES "public"."knowledge_nodes"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_node_sources" ADD CONSTRAINT "knowledge_node_sources_source_scope_fk" FOREIGN KEY ("server_id","source_id") REFERENCES "public"."knowledge_sources"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_reviews" ADD CONSTRAINT "knowledge_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_reviews" ADD CONSTRAINT "knowledge_reviews_edge_scope_fk" FOREIGN KEY ("server_id","edge_id") REFERENCES "public"."knowledge_edges"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_channel_scope_fk" FOREIGN KEY ("server_id","channel_id") REFERENCES "public"."channels"("server_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_edge_sources_reverse_idx" ON "knowledge_edge_sources" USING btree ("server_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_edges_target_idx" ON "knowledge_edges" USING btree ("server_id","to_node_id");--> statement-breakpoint
CREATE INDEX "knowledge_node_sources_reverse_idx" ON "knowledge_node_sources" USING btree ("server_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_reviews_edge_idx" ON "knowledge_reviews" USING btree ("server_id","edge_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "knowledge_sources_visibility_idx" ON "knowledge_sources" USING btree ("server_id","channel_id","occurred_at");
