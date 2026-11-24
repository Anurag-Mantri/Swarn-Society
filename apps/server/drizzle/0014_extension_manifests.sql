CREATE TABLE "extension_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"registered_by" uuid NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_manifests_version_unique" UNIQUE("server_id","slug","version")
);
--> statement-breakpoint
CREATE TABLE "host_extension_approvals" (
	"host_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"capabilities" jsonb NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_extension_approvals_host_id_manifest_id_pk" PRIMARY KEY("host_id","manifest_id")
);
--> statement-breakpoint
ALTER TABLE "extension_manifests" ADD CONSTRAINT "extension_manifests_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_manifests" ADD CONSTRAINT "extension_manifests_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_extension_approvals" ADD CONSTRAINT "host_extension_approvals_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_extension_approvals" ADD CONSTRAINT "host_extension_approvals_manifest_id_extension_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."extension_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_extension_approvals" ADD CONSTRAINT "host_extension_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "host_extension_approvals_manifest_idx" ON "host_extension_approvals" USING btree ("manifest_id");