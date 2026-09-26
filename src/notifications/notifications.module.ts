import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { AfricasTalkingSmsSender } from './sms/africas-talking-sms.sender.js';
import { SMS_SENDER } from './sms/sms-sender.js';

/**
 * Notifications bounded context (Step 11).
 *
 * The binding below is the swap point the step asks for: `SMS_SENDER` is
 * resolved to Africa's Talking here and nowhere else, so replacing the provider
 * is this one line. A test that wants to assert on the message text provides its
 * own binding for the token instead.
 *
 * `NotificationsService` is exported rather than the sender: callers ask for
 * "send the user a code", not for "an SMS client". If a second channel appears
 * (WhatsApp, email), it is added to the service and every caller keeps working.
 */
@Module({
  providers: [
    NotificationsService,
    { provide: SMS_SENDER, useClass: AfricasTalkingSmsSender },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

