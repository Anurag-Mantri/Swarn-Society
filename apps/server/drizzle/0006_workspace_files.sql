CREATE TABLE "workspace_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"path" text NOT NULL,
	"document" "bytea",
	CONSTRAINT "workspace_files_server_path_unique" UNIQUE("server_id","path")
);
--> statement-breakpoint
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;