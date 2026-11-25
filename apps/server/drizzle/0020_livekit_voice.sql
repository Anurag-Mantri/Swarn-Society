CREATE TABLE "voice_hosts" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_hosts" ADD CONSTRAINT "voice_hosts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_hosts" ADD CONSTRAINT "voice_hosts_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;