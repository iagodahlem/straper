_{{agent_name}}_completion() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local commands="fd-new fd-new-prompt fd-close fd-status fd-work-prompt worker worktree sync-branch ship ship-prompt session-review session-review-prompt completion"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
    return
  fi

  case "${COMP_WORDS[1]}" in
    completion)
      COMPREPLY=( $(compgen -W "bash zsh" -- "${cur}") )
      ;;
    fd-new|fd-new-prompt)
      COMPREPLY=( $(compgen -W "--effort --priority --repo --provider-hint --profile-hint --branch-suffix --verification-command --dry-run" -- "${cur}") )
      ;;
    fd-close)
      COMPREPLY=( $(compgen -W "--force --dry-run" -- "${cur}") )
      ;;
    fd-work-prompt|worker)
      COMPREPLY=( $(compgen -W "--base --provider --profile --model --dry-run" -- "${cur}") )
      ;;
    worktree)
      COMPREPLY=( $(compgen -W "--base --dry-run" -- "${cur}") )
      ;;
    sync-branch)
      COMPREPLY=( $(compgen -W "--base --dry-run" -- "${cur}") )
      ;;
    ship|ship-prompt)
      COMPREPLY=( $(compgen -W "--base --tier --quick --skip-verify --push --create-pr --title --body-file --dry-run" -- "${cur}") )
      ;;
    session-review|session-review-prompt)
      COMPREPLY=( $(compgen -W "--run-session-end --dry-run" -- "${cur}") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}

complete -F _{{agent_name}}_completion {{agent_name}}
