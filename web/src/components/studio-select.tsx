import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type StudioSelectOption = { value: string; label: string; disabled?: boolean }

type StudioSelectProps = {
  value: string
  onValueChange: (value: string) => void
  options: readonly StudioSelectOption[]
  disabled?: boolean
  placeholder?: string
  'aria-label': string
  className?: string
}

// App-specific data adapter. The trigger, popup, and items are the official
// shadcn/Base UI Select components, not browser-native <select>/<option> tags.
const EMPTY = '__studio_select_empty__'

export function StudioSelect({
  value, onValueChange, options, disabled, placeholder, className,
  'aria-label': ariaLabel,
}: StudioSelectProps) {
  const hasEmpty = options.some(option => option.value === '')
  return <Select
    value={value === '' ? (hasEmpty ? EMPTY : null) : value}
    onValueChange={next => onValueChange(next === EMPTY ? '' : next ?? '')}
    disabled={disabled}
  >
    <SelectTrigger aria-label={ariaLabel} className={className ?? 'w-full'}>
      <SelectValue placeholder={placeholder ?? 'Choose an option'} />
    </SelectTrigger>
    <SelectContent>
      {options.map(option => <SelectItem
        key={option.value}
        value={option.value === '' ? EMPTY : option.value}
        disabled={option.disabled}
      >{option.label}</SelectItem>)}
    </SelectContent>
  </Select>
}
