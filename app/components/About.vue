<script setup lang="ts">
import { APP_NAME, GITHUB } from '@/core/config/env.ts'
import ChannelIcons from '@/components/channel-icons/ChannelIcons.vue'
import WeChat from '@/components/channel-icons/WeChat.vue'
import { isDesktop } from '@/core/utils/desktop'

const desktop = isDesktop()
</script>

<template>
  <h1>{{ APP_NAME }}</h1>
  <div class="w-120">
    <p class="text-xl">
      {{ $t('about_thanks') }}
    </p>
    <p v-if="!desktop">
      {{ $t('github_address') }}<a :href="GITHUB" target="_blank">{{ GITHUB }}</a>
    </p>
    <div class="flex flex-col gap-2 mt-20">
      <div class="">常见问题： <RouterLink to="/help">常见问题解答</RouterLink></div>
      <div v-if="desktop" class="color-gray">桌面版为离线版本，不提供在线反馈与交流渠道。</div>
      <div v-if="!desktop" class="flex items-center">{{ $t('about_wechat_feedback') }}<WeChat /></div>
      <div v-if="!desktop" class="">
        {{ $t('about_ticket_feedback')
        }}<a :href="`https://v.wjx.cn/vm/ev0W7fv.aspx#`" target="_blank">https://v.wjx.cn/vm/ev0W7fv.aspx#</a>
      </div>
      <div v-if="!desktop" class="flex items-center">
        {{ $t('about_other_channels') }}
        <ChannelIcons type="horizontal" :share="false" :wechat="false" :github="false" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss"></style>
