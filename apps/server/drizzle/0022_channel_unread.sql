CREATE TABLE "channel_read_cursors" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"read_id" uuid NOT NULL,
	CONSTRAINT "channel_read_cursors_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "channel_read_cursors" ADD CONSTRAINT "channel_read_cursors_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_read_cursors" ADD CONSTRAINT "channel_read_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_read_cursors_user_idx" ON "channel_read_cursors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_root_unread_idx" ON "messages" USING btree ("channel_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "messages"."thread_id" is null;