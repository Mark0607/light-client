<template>
  <div class="address__container">
    <v-tooltip bottom close-delay="1400">
      <template #activator="{ on }">
        <p class="address__label" v-on="on" @click="copy">
          {{ address | truncate(8) }}
        </p>
      </template>
      <div class="address__tooltip">
        <input ref="copy" class="address__input" :value="address" />
        <div>
          {{
            copied ? $t('address-display.copied') : $t('address-display.copy')
          }}
        </div>
      </div>
    </v-tooltip>
  </div>
</template>

<script lang="ts">
import { Component, Prop, Vue } from 'vue-property-decorator';

@Component({})
export default class AddressDisplay extends Vue {
  @Prop({ required: true })
  address!: string;

  copied: boolean = false;
  private timeout: number = 0;

  selectAddress(input?: HTMLInputElement): void {
    if (input) {
      input.focus();
      input.select();
    }
  }

  deselectAddress(input?: HTMLInputElement): void {
    if (input) {
      input.blur();
    }
  }

  copy(event: MouseEvent) {
    event.stopPropagation();

    // Select address
    this.selectAddress(this.$refs.copy as HTMLInputElement);
    this.copied = document.execCommand('copy');

    // Deselect text
    this.deselectAddress(this.$refs.copy as HTMLInputElement);

    if (this.timeout) {
      clearTimeout(this.timeout);
    }

    this.timeout = (setTimeout(() => {
      this.copied = false;
    }, 2000) as unknown) as number;
  }
}
</script>

<style lang="scss" scoped>
@import '../scss/colors';

.address {
  &__container {
    color: $color-white;
    font-family: Roboto, sans-serif;
    font-size: 16px;
    line-height: 19px;
    display: flex;
    align-items: center;
  }

  &__tooltip {
    text-align: center;
  }

  &__label {
    cursor: pointer;
    margin: 0;
    border-radius: 3px;

    &:hover {
      background-color: $secondary-color;
      color: $color-white;
    }
  }

  &__input {
    width: 340px;
    text-align: center;
  }
}
</style>
