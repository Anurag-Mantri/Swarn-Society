ALTER TABLE "agent_hosts" ADD CONSTRAINT "agent_hosts_agent_id_host_id_pk" PRIMARY KEY("agent_id","host_id");--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_server_id_user_id_role_id_pk" PRIMARY KEY("server_id","user_id","role_id");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_server_id_user_id_pk" PRIMARY KEY("server_id","user_id");