import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { WEBHOOK_EVENT_ID_HEADER } from '../common/constants/webhook.constants.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { WebhookEventDto } from './dto/webhook-event.dto.js';
import { WebhookReceiptDto } from './dto/webhook-receipt.dto.js';
import { MockWebhookReceiverService } from './mock-webhook-receiver.service.js';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly receiver: MockWebhookReceiverService) {}

  @Post('mock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Demo webhook receiver',
    description:
      'Stands in for a customer endpoint. Point WEBHOOK_URL here to watch status-change events arrive. Deliveries are at-least-once; this receiver acknowledges repeats but reports them as duplicates.',
  })
  @ApiHeader({ name: WEBHOOK_EVENT_ID_HEADER, required: false })
  @ApiBody({ type: WebhookEventDto })
  @ApiOkResponse({ type: WebhookReceiptDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  receive(@Body() event: WebhookEventDto): Promise<WebhookReceiptDto> {
    return this.receiver.receive(event);
  }
}
