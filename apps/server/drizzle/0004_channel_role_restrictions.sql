CREATE TABLE "channel_role_restrictions" (
	"channel_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"denied" integer NOT NULL,
	CONSTRAINT "channel_role_restrictions_channel_id_role_id_pk" PRIMARY KEY("channel_id","role_id"),
	CONSTRAINT "channel_role_restrictions_denied_valid" CHECK ("channel_role_restrictions"."denied" between 1 and 7)
);
--> statement-breakpoint
ALTER TABLE "channel_role_restrictions" ADD CONSTRAINT "channel_role_restrictions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_role_restrictions" ADD CONSTRAINT "channel_role_restrictions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;