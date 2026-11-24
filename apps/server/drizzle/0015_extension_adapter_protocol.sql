CREATE TABLE "extension_adapters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"extension" text NOT NULL,
	"byte_length" integer NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_resources_session_id_unique" UNIQUE("session_id","id")
);
--> statement-breakpoint
CREATE TABLE "extension_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"adapter_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extension_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"format" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_adapters" ADD CONSTRAINT "extension_adapters_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_adapters" ADD CONSTRAINT "extension_adapters_manifest_id_extension_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."extension_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_resources" ADD CONSTRAINT "extension_resources_session_id_extension_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."extension_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_sessions" ADD CONSTRAINT "extension_sessions_adapter_id_extension_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."extension_adapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_sessions" ADD CONSTRAINT "extension_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_snapshots" ADD CONSTRAINT "extension_snapshots_resource_scope_fk" FOREIGN KEY ("session_id","resource_id") REFERENCES "public"."extension_resources"("session_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_sessions_connection_idx" ON "extension_sessions" USING btree ("connection_id");