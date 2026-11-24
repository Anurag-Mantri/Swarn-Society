ALTER TABLE "messages" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_unique" UNIQUE("channel_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_same_channel_thread_fk" FOREIGN KEY ("channel_id","thread_id") REFERENCES "public"."messages"("channel_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");
