CREATE TABLE "task_coordination_daily" (
	"channel_id" uuid NOT NULL,
	"day" date NOT NULL,
	"duplicate_intent_attempts" integer DEFAULT 0 NOT NULL,
	"busy_agent_attempts" integer DEFAULT 0 NOT NULL,
	"competing_claim_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_coordination_daily_channel_id_day_pk" PRIMARY KEY("channel_id","day")
);
--> statement-breakpoint
ALTER TABLE "task_coordination_daily" ADD CONSTRAINT "task_coordination_daily_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;