import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { CommunityService } from './community.service';
import { CreatePostDto, CreateReplyDto } from './dto/community.dto';

/**
 * The learner's Learning Community. Open to the learner audience (participating
 * is not an org-granted capability); the whole module is gated by the org's
 * `community_enabled` flag, checked in the service. `:postId` is the post's
 * public UUID (§10.34); replies are addressed by their integer id.
 */
@Controller('learner/community')
@Roles('learner')
export class LearnerCommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly publicId: PublicIdService,
  ) {}

  @Get()
  async feed(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Query('type') type?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.community.feed(scope, user, {
      type,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  async create(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePostDto,
  ) {
    return this.community.createPost(scope, user, dto);
  }

  @Get(':postId')
  async detail(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.detail(scope, user, postId);
  }

  @Delete(':postId')
  async remove(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.deleteOwnPost(scope, user, postId);
  }

  @Post(':postId/replies')
  @HttpCode(201)
  async reply(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
    @Body() dto: CreateReplyDto,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.reply(scope, user, postId, dto);
  }

  @Post(':postId/like')
  @HttpCode(200)
  async like(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.like(scope, user, postId);
  }

  @Delete(':postId/like')
  async unlike(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId') postIdParam: string,
  ) {
    const postId = await this.publicId.resolveIdOrThrow(
      'community_posts',
      postIdParam,
    );
    return this.community.unlike(scope, user, postId);
  }

  @Delete('replies/:replyId')
  async removeReply(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('replyId', ParseIntPipe) replyId: number,
  ) {
    return this.community.deleteOwnReply(scope, user, replyId);
  }
}
